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
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	for index := range nonce {
		nonce[index] = byte(100 + index)
	}
	envelope := append(append(append([]byte{}, privateObjectMagic...), nonce...), gcm.Seal(nil, nonce, contents, []byte(objectKey))...)
	path := filepath.Join(t.TempDir(), "document.pdf")
	if err := os.WriteFile(path, envelope, 0o600); err != nil {
		t.Fatal(err)
	}

	decrypted, err := readPrivateObject(path, key, objectKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(decrypted) != string(contents) {
		t.Fatalf("unexpected plaintext: %q", decrypted)
	}
	if _, err := readPrivateObject(path, key, "upbit/other/document.pdf"); err == nil {
		t.Fatal("object key substitution was accepted")
	}
}
