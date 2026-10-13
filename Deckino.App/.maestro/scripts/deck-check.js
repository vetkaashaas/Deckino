// A6's milestone, from the website's side: the deck built on the phone is public, and the public deck page's API
// (what deckino.com/deck/{id} shows) has the commander and the cards added by name and by scan.
var signedIn = http.post(API + '/api/auth/token', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: output.email, password: output.password }),
});
if (signedIn.status !== 200) throw new Error('Signing in failed: HTTP ' + signedIn.status);
var auth = { Authorization: 'Bearer ' + json(signedIn.body).accessToken };
var decks = json(http.get(API + '/api/decks', { headers: auth }).body);
if (decks.length !== 1) throw new Error('Expected 1 deck, found ' + decks.length);
var deck = json(http.get(API + '/api/public/decks/' + decks[0].id).body).deck;
var list = function (section) {
  return deck[section].map(function (e) { return e.card.name + ' x' + e.quantity; }).sort().join(', ');
};
var seen = deck.name + ' | commander: ' + list('commander') + ' | main: ' + list('mainboard');
var expected = 'Krenko Goblins | commander: Krenko, Mob Boss x1 | main: Forest x3, Lightning Bolt x1';
if (seen !== expected) throw new Error('The public deck is "' + seen + '", expected "' + expected + '"');
output.deckSeen = seen;
