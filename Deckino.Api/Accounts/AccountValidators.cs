using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;

namespace Deckino.Api.Accounts;

// Usernames: 3-20 letters, digits, _ or -, not reserved. Identity itself checks uniqueness (case-insensitively,
// through the normalized name).
public sealed partial class UsernameValidator : IUserValidator<User>
{
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "admin", "administrator", "deckino", "support", "help", "moderator", "mod", "staff", "team",
        "system", "root", "api", "official", "security", "scryfall", "wizards",
    };

    [GeneratedRegex("^[A-Za-z0-9_-]{3,20}$")]
    private static partial Regex Allowed();

    public Task<IdentityResult> ValidateAsync(UserManager<User> manager, User user)
    {
        var name = user.UserName ?? "";
        if (!Allowed().IsMatch(name))
        {
            return Task.FromResult(IdentityResult.Failed(new IdentityError
            {
                Code = "InvalidUserName",
                Description = "Use 3 to 20 letters, digits, _ or -.",
            }));
        }
        if (Reserved.Contains(name))
        {
            return Task.FromResult(IdentityResult.Failed(new IdentityError
            {
                Code = "ReservedUserName",
                Description = "That username is reserved. Choose another.",
            }));
        }
        return Task.FromResult(IdentityResult.Success);
    }
}

// Caps password length so a huge password can't be used to make hashing expensive.
public sealed class PasswordLengthValidator : IPasswordValidator<User>
{
    public const int MaxLength = 128;

    public Task<IdentityResult> ValidateAsync(UserManager<User> manager, User user, string? password) =>
        Task.FromResult(password?.Length > MaxLength
            ? IdentityResult.Failed(new IdentityError
            {
                Code = "PasswordTooLong",
                Description = $"Passwords can be at most {MaxLength} characters.",
            })
            : IdentityResult.Success);
}
