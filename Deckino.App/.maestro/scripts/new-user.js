// A fresh account for this run (the E2E database outlives runs). Usernames: 3-20 of A-Z a-z 0-9 _ -.
var id = Date.now().toString(36);
output.email = 'app-' + id + '@example.com';
output.username = 'app_' + id;
output.renamed = 'app_' + id + '_v2';
output.password = 'correct horse battery';
output.newPassword = 'second horse battery';
