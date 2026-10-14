// A8: another player's public deck and binder, made through the API by a second account (output.owner…), for the
// flow's own account (output.email, binder-user.js) to find, open by link and copy.
var id = Date.now().toString(36);
output.ownerEmail = 'owner-' + id + '@example.com';
output.ownerName = 'own_' + id;
var registered = http.post(API + '/api/account/register', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.ownerEmail, username: output.ownerName, password: output.password }),
});
if (registered.status !== 204) throw new Error('Registering the owner failed: HTTP ' + registered.status);

var emails = json(http.get(API + '/api/dev/account-emails?to=' + encodeURIComponent(output.ownerEmail)).body);
var link = emails.filter(function (e) { return e.subject === 'Verify your email'; })[0].link.split(' ')[0];
var param = function (name) { return decodeURIComponent(link.match(new RegExp('[?&]' + name + '=([^&]+)'))[1]); };
http.post(API + '/api/account/verify-email', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: param('userId'), token: param('token') }),
});

var signedIn = http.post(API + '/api/auth/token', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.ownerEmail, password: output.password }),
});
if (signedIn.status !== 200) throw new Error('Signing the owner in failed: HTTP ' + signedIn.status);
var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + json(signedIn.body).accessToken };

function call(method, path, body) {
  var send = method === 'PUT' ? http.put : http.post;
  var response = send(API + path, { headers: headers, body: JSON.stringify(body) });
  if (response.status >= 300) throw new Error(path + ' failed: HTTP ' + response.status + ' ' + response.body);
  return json(response.body);
}

output.deckName = 'Krenko Swarm ' + id;
var deck = call('POST', '/api/decks', {
  name: output.deckName,
  format: 'commander',
  cards: {
    commander: [{ scryfallId: output.krenko, quantity: 1, finish: 'nonfoil' }],
    mainboard: [{ scryfallId: output.bolt, quantity: 1, finish: 'nonfoil' }],
    sideboard: [],
  },
});
call('PUT', '/api/decks/' + deck.id + '/visibility', { isPublic: true });
output.deckId = deck.id;

var binder = call('POST', '/api/binders', { name: 'Trades ' + id });
call('POST', '/api/binders/' + binder.id + '/cards/batch', {
  cards: [{ card: { scryfallId: output.forest, finish: 'nonfoil', condition: 'NM', language: 'en' }, copies: 3 }],
});
call('PUT', '/api/binders/' + binder.id, { isPublic: true });
output.binderId = binder.id;
