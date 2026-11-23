# bbosong-push-relay

Small, free push relay for the 뽀송이 app (Firebase project `bbosong-app`, Spark plan — no Cloud Functions).

Every 5 minutes a GitHub Actions job reads new lounge notification documents (like / comment / follow)
and admin announcements (`push_broadcasts`) from Firestore and sends FCM HTTP v1 pushes, then marks each
document with `relayedAt` so it is sent only once.

- Triggers: `schedule` and `workflow_dispatch` only.
- Credentials: a least-privilege service account key stored only in the `FIREBASE_SA` Actions secret.
- Guards: bounded reads per run, recent-window only; uses only free services (GitHub Actions on a public repo, FCM, Firestore free quota).
