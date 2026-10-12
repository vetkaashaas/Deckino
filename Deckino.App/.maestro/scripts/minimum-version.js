// Sets the E2E API's minimum app version (a development-only endpoint, reset when the API restarts).
const response = http.put('http://localhost:5890/api/dev/app/minimum-version', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minimumVersion: VERSION }),
})
if (response.status !== 204) throw new Error(`minimum-version: HTTP ${response.status}`)
