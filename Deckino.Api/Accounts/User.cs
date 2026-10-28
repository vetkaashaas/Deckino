using Microsoft.AspNetCore.Identity;

namespace Deckino.Api.Accounts;

// A Deckino account. UserName is the public username; Email is private and never leaves the account endpoints.
public class User : IdentityUser<Guid>
{
    public DateTimeOffset CreatedAt { get; set; }
    public bool IsAdmin { get; set; } // set by hand in the database; opens /api/admin and the website's Admin page
}
