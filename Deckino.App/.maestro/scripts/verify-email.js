// Opens the verification link the E2E API logged for output.email (the API's /api/dev/account-emails, as the
// website's Playwright tests do), standing in for the user clicking it in their inbox.
var emails = json(http.get(API + '/api/dev/account-emails?to=' + encodeURIComponent(output.email)).body);
var sent = emails.filter(function (e) { return e.subject === 'Verify your email'; });
if (sent.length === 0) throw new Error('No verification email for ' + output.email + ' yet');
var link = sent[sent.length - 1].link.split(' ')[0];
var param = function (name) { return decodeURIComponent(link.match(new RegExp('[?&]' + name + '=([^&]+)'))[1]); };
var verified = http.post(API + '/api/account/verify-email', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: param('userId'), token: param('token') }),
});
if (verified.status !== 204) throw new Error('Verifying failed: HTTP ' + verified.status);
