using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;

namespace Deckino.Api.Accounts;

// "Continue with Google / Apple" on the website. Each provider is on only when its keys are set, so the site shows
// just the buttons that work:
//   Authentication:Google:ClientId, ClientSecret
//   Authentication:Apple:ClientId (the Services ID), TeamId, KeyId, PrivateKey (the .p8 file's text)
// The provider calls back to /signin-google or /signin-apple (register those as redirect URIs). Apple posts its
// answer from another site, so its callback must stay outside /api (WebSecurity refuses cross-site API posts).
// The handler stores the provider's identity in Identity's external cookie and sends the browser to
// /api/account/external/callback, which signs in to the Deckino account with that login, or with that email, or a
// new one. The app's sign-in (bearer tokens) doesn't use this.
public static partial class ExternalLogins
{
    private const string EmailVerified = "email_verified";

    public static void AddExternalLogins(this AuthenticationBuilder auth, IConfiguration configuration)
    {
        var google = configuration.GetSection("Authentication:Google");
        if (google["ClientId"] is { Length: > 0 } googleId)
        {
            auth.AddGoogle(options =>
            {
                options.SignInScheme = IdentityConstants.ExternalScheme;
                options.ClientId = googleId;
                options.ClientSecret = google["ClientSecret"]!;
                // Google's userinfo says whether it has verified the address; only a verified one may join an account.
                options.ClaimActions.MapJsonKey(EmailVerified, "verified_email");
                options.ClaimActions.MapJsonKey(EmailVerified, EmailVerified);
            });
        }

        var apple = configuration.GetSection("Authentication:Apple");
        if (apple["ClientId"] is { Length: > 0 } appleId)
        {
            auth.AddApple(options =>
            {
                options.SignInScheme = IdentityConstants.ExternalScheme;
                options.ClientId = appleId;
                options.TeamId = apple["TeamId"]!;
                options.KeyId = apple["KeyId"]!;
                options.GenerateClientSecret = true;
                var key = apple["PrivateKey"]!;
                options.PrivateKey = (_, _) => Task.FromResult(key.AsMemory());
                options.Scope.Add("email");
                options.Scope.Add("name");
            });
        }
    }

    public static void MapExternalLoginEndpoints(this RouteGroupBuilder account)
    {
        account.MapGet("/external", ProvidersAsync);
        account.MapGet("/external/{provider}", ChallengeAsync).RequireRateLimiting(AccountEndpoints.LoginLimit);
        account.MapGet("/external/callback", CallbackAsync).RequireRateLimiting(AccountEndpoints.LoginLimit);
    }

    // The providers that are set up ("Google", "Apple"), for the login and sign-up buttons.
    private static async Task<string[]> ProvidersAsync(SignInManager<User> signIn) =>
        (await signIn.GetExternalAuthenticationSchemesAsync()).Select(s => s.Name).ToArray();

    // A link, not a fetch: the browser goes to the provider and comes back through the callback.
    private static async Task<IResult> ChallengeAsync(string provider, string? returnTo, SignInManager<User> signIn)
    {
        if ((await signIn.GetExternalAuthenticationSchemesAsync()).All(s => s.Name != provider)) return Results.NotFound();
        var callback = $"/api/account/external/callback?returnTo={Uri.EscapeDataString(SafeReturnTo(returnTo))}";
        return Results.Challenge(signIn.ConfigureExternalAuthenticationProperties(provider, callback), [provider]);
    }

    // Signs in and goes on to returnTo, or back to the login page with ?error= (the page explains it).
    private static async Task<IResult> CallbackAsync(
        string? returnTo, HttpContext http, UserManager<User> users, SignInManager<User> signIn, ILogger<User> log)
    {
        var info = await signIn.GetExternalLoginInfoAsync();
        await http.SignOutAsync(IdentityConstants.ExternalScheme); // one use
        if (info is null) return Failed("external");

        // Signed in with this provider before.
        var result = await signIn.ExternalLoginSignInAsync(info.LoginProvider, info.ProviderKey, isPersistent: true, bypassTwoFactor: true);
        if (result.Succeeded) return Results.LocalRedirect(SafeReturnTo(returnTo));
        if (result.IsLockedOut || result.IsNotAllowed) return Failed("external");

        var email = info.Principal.FindFirstValue(ClaimTypes.Email)?.Trim();
        // Apple only hands out addresses it has verified (its relay addresses too); Google says so per address.
        var verified = info.LoginProvider != GoogleProvider
            || string.Equals(info.Principal.FindFirstValue(EmailVerified), "true", StringComparison.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(email) || !verified) return Failed("external-email");

        var user = await users.FindByEmailAsync(email);
        if (user is null)
        {
            user = await CreateAsync(users, email, info.Principal.FindFirstValue(ClaimTypes.Name));
            if (user is null) return Failed("external");
        }
        else if (!user.EmailConfirmed)
        {
            // Someone registered this address without ever proving they own it; the provider just proved who does.
            // Their password goes, so it can't be used to get into the owner's account.
            user.EmailConfirmed = true;
            await users.UpdateAsync(user);
            if (await users.HasPasswordAsync(user)) await users.RemovePasswordAsync(user);
        }

        var added = await users.AddLoginAsync(user, info);
        if (!added.Succeeded)
        {
            log.LogWarning("Adding the {Provider} login to user {UserId} failed: {Errors}", info.LoginProvider, user.Id,
                string.Join(" ", added.Errors.Select(e => e.Code)));
            return Failed("external");
        }
        await signIn.SignInAsync(user, isPersistent: true, info.LoginProvider);
        return Results.LocalRedirect(SafeReturnTo(returnTo));
    }

    private const string GoogleProvider = "Google";

    // A new account with a confirmed email and no password (forgot password sets one). The username comes from the
    // provider's name or the email, and can be changed on the account page.
    private static async Task<User?> CreateAsync(UserManager<User> users, string email, string? name)
    {
        var stem = NotAllowed().Replace(name ?? "", "");
        if (stem.Length < 3) stem = NotAllowed().Replace(email.Split('@')[0], "");
        if (stem.Length < 3) stem = "player";
        stem = stem[..Math.Min(stem.Length, 15)];

        for (var attempt = 0; attempt < 5; attempt++)
        {
            var user = new User
            {
                UserName = attempt == 0 ? stem : $"{stem}{Random.Shared.Next(1000, 100000)}",
                Email = email,
                EmailConfirmed = true,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            var created = await users.CreateAsync(user);
            if (created.Succeeded) return user;
            // Only a taken or reserved username is worth another try (a second sign-in at once took the email).
            if (!created.Errors.All(e => e.Code is nameof(IdentityErrorDescriber.DuplicateUserName) or "ReservedUserName")) return null;
        }
        return null;
    }

    [GeneratedRegex("[^A-Za-z0-9_-]")]
    private static partial Regex NotAllowed();

    // Only same-site paths, so a crafted returnTo can't send someone to another site (as on the login page).
    private static string SafeReturnTo(string? value) =>
        value is { } path && path.StartsWith('/') && !path.StartsWith("//") && !path.StartsWith("/\\") ? path : "/";

    private static IResult Failed(string error) => Results.LocalRedirect($"/login?error={error}");
}
