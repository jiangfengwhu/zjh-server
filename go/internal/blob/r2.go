package blob

import (
	"context"
	"errors"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"io"
	"strings"
)

type R2 struct {
	client *s3.Client
	bucket string
}

func (r *R2) Check(ctx context.Context) error {
	_, err := r.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(r.bucket)})
	return err
}

func New(endpoint, bucket, access, secret string) *R2 {
	cfg := aws.Config{Region: "auto", Credentials: credentials.NewStaticCredentialsProvider(access, secret, ""), RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) { o.BaseEndpoint = aws.String(endpoint) })
	return &R2{client: client, bucket: bucket}
}
func keyValid(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.ContainsAny(key, "\\\x00") {
		return false
	}
	for _, p := range strings.Split(key, "/") {
		if p == ".." || p == "." || p == "" {
			return false
		}
	}
	return true
}
func (r *R2) Get(ctx context.Context, key string) (*s3.GetObjectOutput, error) {
	if !keyValid(key) {
		return nil, errors.New("invalid object key")
	}
	return r.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(key)})
}
func (r *R2) Put(ctx context.Context, key, mime string, length int64, body io.Reader) error {
	if !keyValid(key) || length < 0 {
		return errors.New("invalid object metadata")
	}
	_, err := r.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(key), ContentType: aws.String(mime), ContentLength: aws.Int64(length), Body: body})
	return err
}
func (r *R2) Delete(ctx context.Context, key string) error {
	if !keyValid(key) {
		return errors.New("invalid object key")
	}
	_, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(key)})
	return err
}
