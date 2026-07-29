package worker

import (
	"crypto/aes"
	"crypto/cipher"
	"os"
	"path/filepath"
	"testing"
)

func TestReadPrivateObjectDecryptsAuthenticatedEnvelope(t *testing.T) {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index + 1)
	}
	objectKey := "upbit/subject/document.pdf"
	contents := []byte("%PDF-encrypted-at-rest")
	nonce := make([]byte, 12)
	for index := range nonce {
		nonce[index] = byte(100 + index)
	}
	envelope, err := encryptPrivateObject(contents, key, "key-2026", objectKey, nonce)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "document.pdf")
	if err := os.WriteFile(path, envelope, 0o600); err != nil {
		t.Fatal(err)
	}

	keyring := PrivateObjectKeyring{
		CurrentKeyID: "key-2027",
		Keys: map[string][]byte{
			"key-2026": key,
			"key-2027": make([]byte, 32),
		},
	}
	decrypted, err := readPrivateObject(path, keyring, objectKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(decrypted) != string(contents) {
		t.Fatalf("unexpected plaintext: %q", decrypted)
	}
	if _, err := readPrivateObject(path, keyring, "upbit/other/document.pdf"); err == nil {
		t.Fatal("object key substitution was accepted")
	}
}

func TestReadPrivateObjectUsesExplicitLegacyKeyAfterRotation(t *testing.T) {
	legacyKey := make([]byte, 32)
	currentKey := make([]byte, 32)
	for index := range legacyKey {
		legacyKey[index] = byte(index + 1)
		currentKey[index] = byte(index + 33)
	}
	objectKey := "upbit/subject/legacy.pdf"
	contents := []byte("%PDF-legacy-envelope")
	block, err := aes.NewCipher(legacyKey)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	envelope := append(append([]byte{}, legacyPrivateObjectMagic...), nonce...)
	envelope = append(envelope, gcm.Seal(nil, nonce, contents, []byte(objectKey))...)
	path := filepath.Join(t.TempDir(), "legacy.pdf")
	if err := os.WriteFile(path, envelope, 0o600); err != nil {
		t.Fatal(err)
	}

	decrypted, err := readPrivateObject(path, PrivateObjectKeyring{
		CurrentKeyID: "current",
		LegacyKeyID:  "legacy",
		Keys: map[string][]byte{
			"current": currentKey,
			"legacy":  legacyKey,
		},
	}, objectKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(decrypted) != string(contents) {
		t.Fatalf("unexpected plaintext: %q", decrypted)
	}
}
