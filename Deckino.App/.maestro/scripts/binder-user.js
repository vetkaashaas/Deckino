// A4-A6: a fresh account made through the API (account.yaml covers registering in the app), verified by
// verify-email.js, and the printings the flow "scans" (e2e-scan, since the emulator's camera can't see a card).
// PREFIX (env) tells the flows' accounts apart.
var prefix = typeof PREFIX === 'undefined' ? 'binders' : PREFIX;
var id = Date.now().toString(36);
output.email = prefix + '-' + id + '@example.com';
output.username = prefix.slice(0, 4) + '_' + id;
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
output.krenko = find('Krenko, Mob Boss');
