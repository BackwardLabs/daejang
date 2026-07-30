package source

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
)

type capturingArtifactStore struct {
	value   []byte
	options artifactstore.PutOptions
}

func (s *capturingArtifactStore) Put(_ context.Context, value []byte, options artifactstore.PutOptions) (artifactstore.Ref, error) {
	s.value = append([]byte{}, value...)
	s.options = options
	digest := sha256.Sum256(value)
	return artifactstore.Ref{Algorithm: "sha256", Digest: hex.EncodeToString(digest[:])}, nil
}

func TestEncryptingArtifactStoreNeverDelegatesRestrictedPlaintext(t *testing.T) {
	for name, mediaType := range map[string]string{
		"pdf":             "application/pdf",
		"parser evidence": privateParserEvidenceMediaType,
	} {
		t.Run(name, func(t *testing.T) {
			delegate := &capturingArtifactStore{}
			key := bytes.Repeat([]byte{7}, 32)
			plaintext := []byte("synthetic restricted artifact")
			_, err := (EncryptingArtifactStore{
				Store: delegate,
				Key:   key,
				KeyID: "key-2026",
			}).Put(context.Background(), plaintext, artifactstore.PutOptions{MediaType: mediaType})
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(delegate.value, plaintext) || delegate.options.MediaType != "application/vnd.giwa.private-object" {
				t.Fatal("restricted plaintext crossed the artifact-store boundary")
			}
			keyIDLength := int(delegate.value[len(privateArtifactMagic)])
			keyIDStart := len(privateArtifactMagic) + 1
			digestStart := keyIDStart + keyIDLength
			if string(delegate.value[keyIDStart:digestStart]) != "key-2026" {
				t.Fatal("encrypted artifact did not carry its key ID")
			}
			digest := sha256.Sum256(plaintext)
			if !bytes.Equal(delegate.value[digestStart:digestStart+sha256.Size], digest[:]) {
				t.Fatal("encrypted artifact did not carry its authenticated plaintext digest")
			}
			decrypted, err := DecryptPrivateArtifactEnvelope(delegate.value, map[string][]byte{"key-2026": key})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(decrypted, plaintext) {
				t.Fatal("encrypted artifact did not round-trip")
			}
		})
	}
}

func TestDecryptPrivateArtifactEnvelopeFailsClosed(t *testing.T) {
	delegate := &capturingArtifactStore{}
	key := bytes.Repeat([]byte{9}, 32)
	_, err := (EncryptingArtifactStore{Store: delegate, Key: key, KeyID: "current"}).Put(
		context.Background(), []byte("restricted"), artifactstore.PutOptions{MediaType: privateParserEvidenceMediaType},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecryptPrivateArtifactEnvelope(delegate.value, map[string][]byte{"other": key}); err == nil {
		t.Fatal("unknown key ID was accepted")
	}
	tampered := append([]byte(nil), delegate.value...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := DecryptPrivateArtifactEnvelope(tampered, map[string][]byte{"current": key}); err == nil {
		t.Fatal("tampered envelope was accepted")
	}
}
