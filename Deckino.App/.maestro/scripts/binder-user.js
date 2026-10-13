// A4/A5: a fresh account made through the API (account.yaml covers registering in the app), verified by
// verify-email.js, and the printings the flow "scans" (e2e-scan, since the emulator's camera can't see a card).
var id = Date.now().toString(36);
output.email = 'binders-' + id + '@example.com';
output.username = 'bind_' + id;
output.password = 'correct horse battery';
var registered = http.post(API + '/api/account/register', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.email, username: output.username, password: output.password }),
});
if (registered.status !== 204) throw new Error('Registering failed: HTTP ' + registered.status);

function find(name) {
  var cards = json(http.get(API + '/api/cards?q=' + encodeURIComponent(name)).body).cards;
  var card = cards.filter(function (c) { return c.name === name; })[0];
  if (!card) throw new Error(name + ' is not in the E2E catalogue');
  return card.id;
}
output.bolt = find('Lightning Bolt');
output.forest = find('Forest');
