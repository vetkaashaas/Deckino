// After deleting the account in the app, its email and password no longer sign in.
var attempt = http.post(API + '/api/auth/token', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.email, password: output.newPassword }),
});
if (attempt.status !== 401) throw new Error('The deleted account still signs in: HTTP ' + attempt.status);
