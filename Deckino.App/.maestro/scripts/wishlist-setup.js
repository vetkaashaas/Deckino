// A7: what the account already has before the flow, made through the API (binders.yaml and decks.yaml cover making
// these in the app): 2 Forests in a binder, a Lightning Bolt on the wishlist, and a Goblins deck (Krenko, a Forest,
// Neheb) that needs the Krenko and the Neheb.
var signedIn = http.post(API + '/api/auth/token', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.email, password: output.password }),
});
if (signedIn.status !== 200) throw new Error('Signing in failed: HTTP ' + signedIn.status);
var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + json(signedIn.body).accessToken };

function post(path, body) {
  var response = http.post(API + path, { headers: headers, body: JSON.stringify(body) });
  if (response.status >= 300) throw new Error(path + ' failed: HTTP ' + response.status + ' ' + response.body);
  return json(response.body);
}

var binder = post('/api/binders', { name: 'Lands' });
post('/api/binders/' + binder.id + '/cards/batch', {
  cards: [{ card: { scryfallId: output.forest, finish: 'nonfoil', condition: 'NM', language: 'en' }, copies: 2 }],
});
post('/api/wishlist/batch', { cards: [{ scryfallId: output.bolt, quantity: 1 }] });
post('/api/decks', {
  name: 'Goblins',
  format: 'commander',
  cards: {
    commander: [{ scryfallId: output.krenko, quantity: 1, finish: 'nonfoil' }],
    mainboard: [
      { scryfallId: output.forest, quantity: 1, finish: 'nonfoil' },
      { scryfallId: output.neheb, quantity: 1, finish: 'nonfoil' },
    ],
    sideboard: [],
  },
});
