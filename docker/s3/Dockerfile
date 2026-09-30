# syntax=docker/dockerfile:1
#
# The S3-compatible server with this project's development credentials baked in.
#
# The credentials could be bind-mounted instead, but Docker Desktop cannot always read the
# project directory (it registers the mount and then shows it empty), and a stack that only
# works on some machines is worse than a four-line image.
FROM chrislusf/seaweedfs:4.48

COPY identities.json /etc/chitrayaan-s3/identities.json
