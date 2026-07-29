package worker

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"
	"os"
)

var (
	privateObjectMagic       = []byte("GIWAOBJ1")
	errPrivateObjectNotFound = errors.New("private object not found")
)

const maxPrivateObjectBytes = 20<<20 + 64

func readPrivateObject(path string, key []byte, objectKey string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errPrivateObjectNotFound
		}
		return nil, err
	}
	if info.Size() > maxPrivateObjectBytes {
		return nil, errors.New("private object exceeds size limit")
	}
	envelope, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(key) == 0 {
		return envelope, nil
	}
	if len(key) != 32 {
		return nil, errors.New("private object encryption key is invalid")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	headerBytes := len(privateObjectMagic) + gcm.NonceSize()
	if len(envelope) < headerBytes+gcm.Overhead() ||
		!bytes.Equal(envelope[:len(privateObjectMagic)], privateObjectMagic) {
		return nil, errors.New("private object envelope is invalid")
	}
	nonce := envelope[len(privateObjectMagic):headerBytes]
	contents, err := gcm.Open(nil, nonce, envelope[headerBytes:], []byte(objectKey))
	if err != nil {
		return nil, fmt.Errorf("decrypt private object: %w", err)
	}
	return contents, nil
}
