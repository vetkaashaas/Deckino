// The user changes their password somewhere else (another device): this signs in separately and changes it, which
// gives the account a new security stamp. The app must notice on its next request and sign out.
var headers = { 'Content-Type': 'application/json' };
var signedIn = http.post(API + '/api/auth/token', {
  headers: headers,
  body: JSON.stringify({ email: output.email, password: output.password }),
});
if (signedIn.status !== 200) throw new Error('Signing in elsewhere failed: HTTP ' + signedIn.status);
var changed = http.put(API + '/api/account/password', {
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + json(signedIn.body).accessToken },
  body: JSON.stringify({ currentPassword: output.password, newPassword: output.newPassword }),
});
if (changed.status !== 200) throw new Error('Changing the password failed: HTTP ' + changed.status);
