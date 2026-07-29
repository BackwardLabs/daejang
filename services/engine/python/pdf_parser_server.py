from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import struct
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any


def _silence_process_output() -> None:
    sink_descriptor = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(sink_descriptor, 1)
        os.dup2(sink_descriptor, 2)
    finally:
        os.close(sink_descriptor)
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


_silence_process_output()

from giwa_pdf_parser import ParseContext, ParsePolicy, SubjectMatchDecision, parse_document_bytes
from giwa_pdf_parser.contracts.enums import SubjectClaimState, SubjectMatchStatus
from giwa_pdf_parser.errors import ParseError, WrongPasswordError
from giwa_pdf_parser.projections import (
    project_internal_document_evidence,
    project_internal_document_evidence_without_subject_match,
)


_REQUEST_MAGIC = b"DJPARS01"
_RESPONSE_MAGIC = b"DJPRES01"
_PING_MAGIC = b"DJPING01"
_PONG_MAGIC = b"DJPONG01"
_REQUEST_HEADER = struct.Struct(">8sIIQ")
_RESPONSE_HEADER = struct.Struct(">8sIIQ")
_MAX_METADATA_BYTES = 16 * 1024
_MAX_PASSWORD_BYTES = 256
_MAX_PDF_BYTES = 20 * 1024 * 1024
_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
_REQUIRED_METADATA_KEYS = {
    "artifactId",
    "importId",
    "subjectRef",
    "collectedAt",
    "expectedSubjectName",
}
_SAFE_ERROR_CODES = {
    "PARSER_REQUEST_INVALID",
    "PARSER_DOCUMENT_REJECTED",
    "SUBJECT_CLAIM_UNAVAILABLE",
    "SUBJECT_MISMATCH",
    "PDF_PASSWORD_INVALID",
    "PARSER_TIMEOUT",
    "PARSER_PROCESS_FAILED",
}


class _RequestTimeout(Exception):
    pass


def _clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)


def _read_exact(connection: socket.socket, size: int) -> bytearray:
    value = bytearray(size)
    view = memoryview(value)
    offset = 0
    try:
        while offset < size:
            count = connection.recv_into(view[offset:])
            if count == 0:
                raise ValueError("truncated request")
            offset += count
    finally:
        view.release()
    return value


def _read_request(connection: socket.socket, prefix: bytearray) -> tuple[dict[str, Any], bytearray, bytearray, bytearray]:
    remainder = _read_exact(connection, _REQUEST_HEADER.size - len(prefix))
    header = bytearray(prefix)
    header.extend(remainder)
    _clear(remainder)
    try:
        magic, metadata_size, password_size, pdf_size = _REQUEST_HEADER.unpack(header)
    finally:
        _clear(header)
    if (
        magic != _REQUEST_MAGIC
        or metadata_size < 2
        or metadata_size > _MAX_METADATA_BYTES
        or password_size > _MAX_PASSWORD_BYTES
        or pdf_size < len(b"%PDF-")
        or pdf_size > _MAX_PDF_BYTES
    ):
        raise ValueError("invalid request frame")

    metadata_bytes: bytearray | None = None
    password_bytes: bytearray | None = None
    pdf_bytes: bytearray | None = None
    try:
        metadata_bytes = _read_exact(connection, metadata_size)
        password_bytes = _read_exact(connection, password_size)
        pdf_bytes = _read_exact(connection, pdf_size)
        if connection.recv(1) != b"":
            raise ValueError("multiple requests per connection are forbidden")
        metadata = json.loads(metadata_bytes.decode("utf-8", errors="strict"))
        if not isinstance(metadata, dict) or set(metadata) != _REQUIRED_METADATA_KEYS:
            raise ValueError("invalid request metadata")
        if not all(isinstance(metadata[key], str) for key in _REQUIRED_METADATA_KEYS):
            raise ValueError("invalid request metadata")
        if not pdf_bytes.startswith(b"%PDF-"):
            raise ValueError("invalid PDF input")
        return metadata, metadata_bytes, password_bytes, pdf_bytes
    except Exception:
        _clear(metadata_bytes)
        _clear(password_bytes)
        _clear(pdf_bytes)
        raise


def _normalized_exact_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())


def _parse(metadata: dict[str, Any], password_bytes: bytearray, pdf_bytes: bytearray) -> bytearray:
    password = password_bytes.decode("utf-8", errors="strict") if password_bytes else None
    try:
        outcome = parse_document_bytes(
            bytes(pdf_bytes),
            context=ParseContext(
                artifact_id=metadata["artifactId"],
                import_id=metadata["importId"],
                subject_ref=metadata["subjectRef"],
                collected_at=datetime.fromisoformat(metadata["collectedAt"].replace("Z", "+00:00")),
            ),
            password=password,
            policy=ParsePolicy(
                max_file_size_bytes=_MAX_PDF_BYTES,
                max_pages=50,
                max_extracted_items=10_000,
            ),
        )
    finally:
        password = None

    expected_name = _normalized_exact_name(metadata["expectedSubjectName"])
    claim = outcome.transient_subject_claim
    if expected_name:
        if claim.state != SubjectClaimState.PRESENT or claim.value is None:
            raise LookupError("SUBJECT_CLAIM_UNAVAILABLE")
        if _normalized_exact_name(claim.value) != expected_name:
            raise LookupError("SUBJECT_MISMATCH")
        decision = SubjectMatchDecision.from_claim(
            claim,
            status=SubjectMatchStatus.MATCH,
            subject_ref=metadata["subjectRef"],
            policy_ref="verified-subject-name-nfkc-exact:v1",
        )
        internal_evidence = project_internal_document_evidence(
            outcome.canonical_result,
            subject_match=decision,
        )
    else:
        decision = SubjectMatchDecision.from_claim(
            claim,
            status=SubjectMatchStatus.INCONCLUSIVE,
            subject_ref=metadata["subjectRef"],
            policy_ref="mvp-subject-comparison-skipped:v1",
        )
        internal_evidence = project_internal_document_evidence_without_subject_match(
            outcome.canonical_result,
            subject_match=decision,
        )
    encoded = bytearray(
        json.dumps(
            internal_evidence.contract_dict(),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    if not encoded or len(encoded) > _MAX_RESPONSE_BYTES:
        _clear(encoded)
        raise RuntimeError("response limit exceeded")
    return encoded


def _send_response(connection: socket.socket, *, status: int, code: str = "", body: bytearray | None = None) -> None:
    safe_code = code if code in _SAFE_ERROR_CODES else "PARSER_PROCESS_FAILED"
    code_bytes = bytearray(safe_code.encode("ascii") if status else b"")
    response_body = body if body is not None else bytearray()
    try:
        connection.sendall(
            _RESPONSE_HEADER.pack(
                _RESPONSE_MAGIC,
                status,
                len(code_bytes),
                len(response_body),
            )
        )
        if code_bytes:
            connection.sendall(code_bytes)
        if response_body:
            connection.sendall(response_body)
        connection.shutdown(socket.SHUT_WR)
    finally:
        _clear(code_bytes)


def _timeout_handler(_signum: int, _frame: object) -> None:
    raise _RequestTimeout()


def _handle_connection(connection: socket.socket, timeout_seconds: float) -> None:
    prefix: bytearray | None = None
    metadata_bytes: bytearray | None = None
    password_bytes: bytearray | None = None
    pdf_bytes: bytearray | None = None
    response: bytearray | None = None
    previous_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        prefix = _read_exact(connection, len(_PING_MAGIC))
        if bytes(prefix) == _PING_MAGIC:
            if connection.recv(1) != b"":
                raise ValueError("invalid health request")
            connection.sendall(_PONG_MAGIC)
            connection.shutdown(socket.SHUT_WR)
            return
        metadata, metadata_bytes, password_bytes, pdf_bytes = _read_request(connection, prefix)
        response = _parse(metadata, password_bytes, pdf_bytes)
        _send_response(connection, status=0, body=response)
    except _RequestTimeout:
        _send_response(connection, status=1, code="PARSER_TIMEOUT")
    except UnicodeError:
        _send_response(connection, status=1, code="PARSER_REQUEST_INVALID")
    except ValueError:
        _send_response(connection, status=1, code="PARSER_REQUEST_INVALID")
    except WrongPasswordError:
        _send_response(connection, status=1, code="PDF_PASSWORD_INVALID")
    except ParseError:
        _send_response(connection, status=1, code="PARSER_DOCUMENT_REJECTED")
    except LookupError as error:
        code = str(error)
        _send_response(
            connection,
            status=1,
            code=code if code in {"SUBJECT_CLAIM_UNAVAILABLE", "SUBJECT_MISMATCH"} else "PARSER_PROCESS_FAILED",
        )
    except Exception:
        _send_response(connection, status=1, code="PARSER_PROCESS_FAILED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        _clear(response)
        _clear(prefix)
        _clear(metadata_bytes)
        _clear(password_bytes)
        _clear(pdf_bytes)


def _serve(socket_path: Path, timeout_seconds: float) -> int:
    if socket_path.exists() or socket_path.is_symlink():
        socket_path.unlink()
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        signal.signal(signal.SIGCHLD, signal.SIG_IGN)
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        while True:
            connection, _ = listener.accept()
            try:
                child = os.fork()
            except OSError:
                connection.close()
                continue
            if child == 0:
                listener.close()
                try:
                    _handle_connection(connection, timeout_seconds)
                finally:
                    connection.close()
                os._exit(0)
            connection.close()
    finally:
        listener.close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--request-timeout-seconds", type=float, default=25.0)
    try:
        arguments = parser.parse_args()
        if not arguments.socket.is_absolute() or arguments.request_timeout_seconds <= 0:
            return 2
        return _serve(arguments.socket, arguments.request_timeout_seconds)
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
