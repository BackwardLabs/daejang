package source

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
)

var privateArtifactMagic = []byte("GIWAOBJ2")

type EncryptingArtifactStore struct {
	Store DocumentImportArtifacts
	Key   []byte
	KeyID string
}

func (s EncryptingArtifactStore) Put(ctx context.Context, value []byte, options artifactstore.PutOptions) (artifactstore.Ref, error) {
	if options.MediaType != "application/pdf" {
		return s.Store.Put(ctx, value, options)
	}
	if s.Store == nil || len(s.Key) != 32 || len(s.KeyID) == 0 || len(s.KeyID) > 255 {
		return artifactstore.Ref{}, errors.New("private PDF artifact encryption is not configured")
	}
	plaintextDigest := sha256.Sum256(value)
	envelope, err := encryptArtifactEnvelope(
		value,
		s.Key,
		s.KeyID,
		"artifact:sha256:"+hex.EncodeToString(plaintextDigest[:]),
	)
	if err != nil {
		return artifactstore.Ref{}, err
	}
	defer clear(envelope)
	options.MediaType = "application/vnd.giwa.private-object"
	return s.Store.Put(ctx, envelope, options)
}

func encryptArtifactEnvelope(contents, key []byte, keyID, associatedData string) ([]byte, error) {
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
	header = append(header, nonce...)
	return append(header, gcm.Seal(nil, nonce, contents, []byte(associatedData))...), nil
}
