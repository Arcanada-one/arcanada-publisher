# Facebook Exact Create and Edit Verification

Facebook can accept a post after only the title reaches the composer. Publisher
therefore treats the GraphQL success response as mutation confirmation, not as
content verification.

Before create, Publisher requires the complete normalized composer body and an
image. After create, it reads the returned canonical post and requires the same
complete body, the expected stable author-profile identity, the same canonical
permalink, and an image.

In-place post edit requires three read-before-edit oracles: exact current body,
expected stable author profile, and `expectedMediaKind=image`. The target
canonical permalink must match. Publisher verifies the complete replacement in
the editor before Save and repeats the same body, author, permalink, and image
checks after Save.

A mismatch before Post or Save aborts without mutation. An error or mismatch
after Post or Save returns `AdapterError` with `unknown=true` and
`reconcileRequired=true`. The caller must inspect the external state and must
not retry blindly.
