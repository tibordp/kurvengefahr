# Sharing

Share… (in the document menu) turns the current document into a link. Opening it shows a
read-only view of that snapshot -- later edits to your document never change what the link shows
-- with an **Edit a copy** button that imports the snapshot as a new document for the viewer to
keep working on. Nothing is added to the viewer's document library until they choose that.

## The privacy model

The document is encrypted in your browser before anything is uploaded. The decryption key rides
in the link's `#…` fragment, which browsers do not send to servers -- so the share service only
ever stores ciphertext it cannot read, and anyone *with* the link can read the document. Treat
the link itself as the secret.

Creating a share runs a short proof-of-work computation in your browser. That is what lets the
service accept uploads from anyone without accounts or sign-ups: producing spam at scale is made
expensive, one genuine share is a moment's work.

Links can expire: the share dialog states the service's retention when it creates one. Sharing
the exact same document again in the same session reuses the existing link rather than uploading
a second copy; a fresh session mints a fresh key, so re-sharing later yields a different (equally
valid) link.

## Self-hosting

The public app uses the share service at `share.kurvengefahr.org`. The service is a small open
component you can run yourself -- see [share-api](../share-api/) -- and a build configured
without one simply has no Share entry.
