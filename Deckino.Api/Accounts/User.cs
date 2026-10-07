using Microsoft.AspNetCore.Identity;

namespace Deckino.Api.Accounts;

// A Deckino account. UserName is the public username; Email is private and never leaves the account endpoints.
public class User : IdentityUser<Guid>
{
    public DateTimeOffset CreatedAt { get; set; }
}
