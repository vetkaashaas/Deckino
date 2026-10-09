# Todo

- Add an option to Resync on the Dataset Sync page. This button will remove the local copy of the files and redownload them from S3, as if it is a fresh installation that has never synced from S3 yet.
- Make sure the pack for import on the card extraction model works as nicely as the model training/embedding model pack for import on a different PC button.
- The app needs to be more strict about card extractions it gives the embedding card identify flow. If the shape does not clearly equate a triangle (this can be calculated from the points it outputs), skip the second card identify flow.
- Turn on suggest corners with the current model by default.
