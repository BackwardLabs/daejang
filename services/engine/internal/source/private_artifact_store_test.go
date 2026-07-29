package source

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
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

func TestEncryptingArtifactStoreNeverDelegatesPlainPDF(t *testing.T) {
	delegate := &capturingArtifactStore{}
	key := bytes.Repeat([]byte{7}, 32)
	plaintext := []byte("%PDF-1.7 private statement")
	_, err := (EncryptingArtifactStore{
		Store: delegate,
		Key:   key,
		KeyID: "key-2026",
	}).Put(context.Background(), plaintext, artifactstore.PutOptions{MediaType: "application/pdf"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(delegate.value, plaintext) || delegate.options.MediaType == "application/pdf" {
		t.Fatal("plaintext PDF crossed the artifact-store boundary")
	}
	keyIDLength := int(delegate.value[len(privateArtifactMagic)])
	keyIDStart := len(privateArtifactMagic) + 1
	nonceStart := keyIDStart + keyIDLength
	if string(delegate.value[keyIDStart:nonceStart]) != "key-2026" {
		t.Fatal("encrypted artifact did not carry its key ID")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(plaintext)
	decrypted, err := gcm.Open(
		nil,
		delegate.value[nonceStart:nonceStart+gcm.NonceSize()],
		delegate.value[nonceStart+gcm.NonceSize():],
		[]byte("artifact:sha256:"+hex.EncodeToString(digest[:])),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatal("encrypted artifact did not round-trip")
	}
}
