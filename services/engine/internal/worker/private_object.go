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
	legacyPrivateObjectMagic = []byte("GIWAOBJ1")
	privateObjectMagic       = []byte("GIWAOBJ2")
	errPrivateObjectNotFound = errors.New("private object not found")
)

const maxPrivateObjectBytes = 20<<20 + 64

type PrivateObjectKeyring struct {
	CurrentKeyID string
	Keys         map[string][]byte
}

func readPrivateObject(path string, keyring PrivateObjectKeyring, objectKey string) ([]byte, error) {
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
	if len(keyring.Keys) == 0 {
		return envelope, nil
	}
	keyID := keyring.CurrentKeyID
	nonceStart := len(privateObjectMagic)
	if len(envelope) >= len(privateObjectMagic)+1 && bytes.Equal(envelope[:len(privateObjectMagic)], privateObjectMagic) {
		keyIDLength := int(envelope[len(privateObjectMagic)])
		keyIDStart := len(privateObjectMagic) + 1
		nonceStart = keyIDStart + keyIDLength
		if keyIDLength == 0 || nonceStart > len(envelope) {
			return nil, errors.New("private object envelope is invalid")
		}
		keyID = string(envelope[keyIDStart:nonceStart])
	} else if !bytes.Equal(envelope[:min(len(envelope), len(legacyPrivateObjectMagic))], legacyPrivateObjectMagic) {
		return nil, errors.New("private object envelope is invalid")
	}
	key := keyring.Keys[keyID]
	if len(key) != 32 {
		return nil, fmt.Errorf("private object encryption key %q is unavailable", keyID)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	headerBytes := nonceStart + gcm.NonceSize()
	if len(envelope) < headerBytes+gcm.Overhead() {
		return nil, errors.New("private object envelope is invalid")
	}
	nonce := envelope[nonceStart:headerBytes]
	contents, err := gcm.Open(nil, nonce, envelope[headerBytes:], []byte(objectKey))
	if err != nil {
		return nil, fmt.Errorf("decrypt private object: %w", err)
	}
	return contents, nil
}

func encryptPrivateObject(contents, key []byte, keyID, objectKey string, nonce []byte) ([]byte, error) {
	if len(key) != 32 || len(keyID) == 0 || len(keyID) > 255 {
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
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("private object nonce is invalid")
	}
	header := append(append([]byte{}, privateObjectMagic...), byte(len(keyID)))
	header = append(header, []byte(keyID)...)
	header = append(header, nonce...)
	return append(header, gcm.Seal(nil, nonce, contents, []byte(objectKey))...), nil
}
