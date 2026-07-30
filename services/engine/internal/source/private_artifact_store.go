package source

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
)

var privateArtifactMagic = []byte("GIWAOBJ3")

const privateParserEvidenceMediaType = "application/vnd.giwa.private-parser-evidence+json"

type EncryptingArtifactStore struct {
	Store DocumentImportArtifacts
	Key   []byte
	KeyID string
}

func (s EncryptingArtifactStore) Put(ctx context.Context, value []byte, options artifactstore.PutOptions) (artifactstore.Ref, error) {
	if options.MediaType != "application/pdf" && options.MediaType != privateParserEvidenceMediaType {
		return s.Store.Put(ctx, value, options)
	}
	if s.Store == nil || len(s.Key) != 32 || len(s.KeyID) == 0 || len(s.KeyID) > 255 {
		return artifactstore.Ref{}, errors.New("private artifact encryption is not configured")
	}
	plaintextDigest := sha256.Sum256(value)
	envelope, err := encryptArtifactEnvelope(
		value,
		s.Key,
		s.KeyID,
		plaintextDigest,
	)
	if err != nil {
		return artifactstore.Ref{}, err
	}
	defer clear(envelope)
	options.MediaType = "application/vnd.giwa.private-object"
	return s.Store.Put(ctx, envelope, options)
}

func encryptArtifactEnvelope(contents, key []byte, keyID string, plaintextDigest [sha256.Size]byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	header := append(append([]byte{}, privateArtifactMagic...), byte(len(keyID)))
	header = append(header, []byte(keyID)...)
	header = append(header, plaintextDigest[:]...)
	header = append(header, nonce...)
	associatedData := []byte("artifact:sha256:" + hex.EncodeToString(plaintextDigest[:]))
	return append(header, gcm.Seal(nil, nonce, contents, associatedData)...), nil
}

// DecryptPrivateArtifactEnvelope opens the restricted artifact envelope using
// the embedded plaintext digest as authenticated data. The digest is verified
// again after decryption so backfill cannot accept substituted plaintext.
func DecryptPrivateArtifactEnvelope(envelope []byte, keys map[string][]byte) ([]byte, error) {
	minimumHeader := len(privateArtifactMagic) + 1 + sha256.Size
	if len(envelope) < minimumHeader || !bytes.Equal(envelope[:len(privateArtifactMagic)], privateArtifactMagic) {
		return nil, errors.New("private artifact envelope is invalid")
	}
	keyIDLength := int(envelope[len(privateArtifactMagic)])
	keyIDStart := len(privateArtifactMagic) + 1
	digestStart := keyIDStart + keyIDLength
	if keyIDLength == 0 || digestStart+sha256.Size > len(envelope) {
		return nil, errors.New("private artifact envelope is invalid")
	}
	keyID := string(envelope[keyIDStart:digestStart])
	key := keys[keyID]
	if len(key) != 32 {
		return nil, fmt.Errorf("private artifact encryption key %q is unavailable", keyID)
	}
	var plaintextDigest [sha256.Size]byte
	copy(plaintextDigest[:], envelope[digestStart:digestStart+sha256.Size])
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonceStart := digestStart + sha256.Size
	ciphertextStart := nonceStart + gcm.NonceSize()
	if ciphertextStart+gcm.Overhead() > len(envelope) {
		return nil, errors.New("private artifact envelope is invalid")
	}
	associatedData := []byte("artifact:sha256:" + hex.EncodeToString(plaintextDigest[:]))
	contents, err := gcm.Open(nil, envelope[nonceStart:ciphertextStart], envelope[ciphertextStart:], associatedData)
	if err != nil {
		return nil, fmt.Errorf("decrypt private artifact: %w", err)
	}
	actualDigest := sha256.Sum256(contents)
	if !bytes.Equal(actualDigest[:], plaintextDigest[:]) {
		clear(contents)
		return nil, errors.New("private artifact plaintext digest mismatch")
	}
	return contents, nil
}
