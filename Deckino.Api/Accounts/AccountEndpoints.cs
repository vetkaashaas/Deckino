using System.Net.Mail;
using System.Security.Claims;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Accounts;

public static class AccountEndpoints
{
    // Rate limit policies (per client IP), configured in Program.cs.
    public const string LoginLimit = "login";
    public const string RegisterLimit = "register";
    public const string EmailLimit = "account-email";
    public const string PasswordCheckLimit = "password-check"; // re-entering the password while signed in

    private const string BadLink = "This link is invalid or has expired. Request a new one.";
    private const string BadLogin = "Email or password is incorrect.";

    private static readonly Lazy<string> UnknownUserHash =
        new(() => new PasswordHasher<User>().HashPassword(new User(), Guid.NewGuid().ToString()));

    public static void MapAccountEndpoints(this WebApplication app)
    {
        var account = app.MapGroup("/api/account");
        account.MapPost("/register", RegisterAsync).RequireRateLimiting(RegisterLimit);
        account.MapPost("/verify-email", VerifyEmailAsync).RequireRateLimiting(LoginLimit);
        account.MapPost("/resend-verification", ResendVerificationAsync).RequireRateLimiting(EmailLimit);
        account.MapPost("/login", LoginAsync).RequireRateLimiting(LoginLimit);
        account.MapPost("/logout", LogoutAsync);
        account.MapPost("/forgot-password", ForgotPasswordAsync).RequireRateLimiting(EmailLimit);
        account.MapPost("/reset-password", ResetPasswordAsync).RequireRateLimiting(LoginLimit);
        account.MapGet("/me", MeAsync);
        account.MapPut("/username", ChangeUsernameAsync).RequireAuthorization();
        account.MapPut("/password", ChangePasswordAsync).RequireAuthorization().RequireRateLimiting(PasswordCheckLimit);
        account.MapDelete("", DeleteAsync).RequireAuthorization().RequireRateLimiting(PasswordCheckLimit);
    }

    // The response is the same whether or not the email already has an account, as long as the username and
    // password are acceptable. Those are checked first, so an invalid one can't reveal which emails exist.
    private static async Task<Results<NoContent, ValidationProblem>> RegisterAsync(
        RegisterRequest request, UserManager<User> users, IAccountEmails emails, AccountLinks links)
    {
        var email = request.Email?.Trim() ?? "";
        if (!IsEmail(email)) return Invalid("email", "Enter a valid email address.");

        var user = new User { UserName = request.Username?.Trim(), Email = email, CreatedAt = DateTimeOffset.UtcNow };
        var password = request.Password ?? "";
        var errors = new List<IdentityError>();
        foreach (var validator in users.UserValidators) errors.AddRange((await validator.ValidateAsync(users, user)).Errors);
        foreach (var validator in users.PasswordValidators) errors.AddRange((await validator.ValidateAsync(users, user, password)).Errors);
        errors.RemoveAll(e => e.Code == nameof(IdentityErrorDescriber.DuplicateEmail));
        if (errors.Count > 0) return Invalid(errors);

        if (await users.FindByEmailAsync(email) is { } existing)
        {
            users.PasswordHasher.HashPassword(existing, password); // as slow as creating an account (no timing tell)
            await emails.SendAlreadyRegisteredAsync(existing, links.Login(), links.ForgotPassword());
            return TypedResults.NoContent();
        }

        var created = await users.CreateAsync(user, password);
        if (!created.Succeeded)
        {
            // Lost a race with another registration for the same email: answer as if it were new.
            return created.Errors.All(e => e.Code == nameof(IdentityErrorDescriber.DuplicateEmail))
                ? TypedResults.NoContent()
                : Invalid(created.Errors);
        }
        await SendVerificationAsync(user, users, emails, links);
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> VerifyEmailAsync(
        LinkRequest request, UserManager<User> users)
    {
        var user = await users.FindByIdAsync(request.UserId.ToString());
        if (user is null || string.IsNullOrEmpty(request.Token)) return LinkProblem();
        if (user.EmailConfirmed) return TypedResults.NoContent(); // opened twice
        var result = await users.ConfirmEmailAsync(user, request.Token);
        if (result.Succeeded) return TypedResults.NoContent();

        // Two clicks at once: the other request may have confirmed it first (and won the concurrency check).
        var confirmed = await users.Users.AsNoTracking().AnyAsync(u => u.Id == user.Id && u.EmailConfirmed);
        return confirmed ? TypedResults.NoContent() : LinkProblem();
    }

    private static async Task<NoContent> ResendVerificationAsync(
        EmailRequest request, UserManager<User> users, IAccountEmails emails, AccountLinks links)
    {
        if (await users.FindByEmailAsync(request.Email?.Trim() ?? "") is { EmailConfirmed: false } user)
        {
            await SendVerificationAsync(user, users, emails, links);
        }
        return TypedResults.NoContent();
    }

    // Unknown email, wrong password and a locked account all get the same answer. Only someone who knows the
    // password learns that the email still needs verifying.
    private static async Task<Results<Ok<AccountResponse>, ProblemHttpResult>> LoginAsync(
        LoginRequest request, UserManager<User> users, SignInManager<User> signIn)
    {
        var user = await users.FindByEmailAsync(request.Email?.Trim() ?? "");
        if (user is null)
        {
            // Check the password against a throwaway hash anyway, so an unknown email takes as long to answer as a
            // wrong password and response times don't reveal which emails have accounts.
            users.PasswordHasher.VerifyHashedPassword(new User(), UnknownUserHash.Value, request.Password ?? "");
            return TypedResults.Problem(BadLogin, statusCode: StatusCodes.Status401Unauthorized);
        }

        var check = await signIn.CheckPasswordSignInAsync(user, request.Password ?? "", lockoutOnFailure: true);
        if (!check.Succeeded) return TypedResults.Problem(BadLogin, statusCode: StatusCodes.Status401Unauthorized);
        if (!user.EmailConfirmed)
        {
            return TypedResults.Problem(
                "Verify your email before logging in. Check your inbox for the link.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        await signIn.SignInAsync(user, isPersistent: true);
        return TypedResults.Ok(AccountResponse.From(user));
    }

    private static async Task<NoContent> LogoutAsync(SignInManager<User> signIn)
    {
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> ForgotPasswordAsync(
        EmailRequest request, UserManager<User> users, IAccountEmails emails, AccountLinks links)
    {
        if (await users.FindByEmailAsync(request.Email?.Trim() ?? "") is { } user)
        {
            var token = await users.GeneratePasswordResetTokenAsync(user);
            await emails.SendPasswordResetAsync(user, links.ResetPassword(user.Id, token));
        }
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> ResetPasswordAsync(
        ResetPasswordRequest request, UserManager<User> users)
    {
        var user = await users.FindByIdAsync(request.UserId.ToString());
        if (user is null || string.IsNullOrEmpty(request.Token)) return LinkProblem();

        var result = await users.ResetPasswordAsync(user, request.Token, request.Password ?? "");
        if (!result.Succeeded)
        {
            return result.Errors.Any(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken))
                ? LinkProblem()
                : Invalid(result.Errors);
        }

        // The link proves they own the address, and a reset should get a locked-out owner back in.
        if (!user.EmailConfirmed)
        {
            user.EmailConfirmed = true;
            await users.UpdateAsync(user);
        }
        await users.ResetAccessFailedCountAsync(user);
        await users.SetLockoutEndDateAsync(user, null);
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<AccountResponse>, UnauthorizedHttpResult>> MeAsync(
        ClaimsPrincipal principal, UserManager<User> users, SignInManager<User> signIn)
    {
        if (principal.Identity?.IsAuthenticated != true) return TypedResults.Unauthorized();
        if (await users.GetUserAsync(principal) is not { } user)
        {
            await signIn.SignOutAsync(); // the account was deleted
            return TypedResults.Unauthorized();
        }
        return TypedResults.Ok(AccountResponse.From(user));
    }

    private static async Task<Results<Ok<AccountResponse>, ValidationProblem, UnauthorizedHttpResult>> ChangeUsernameAsync(
        ChangeUsernameRequest request, ClaimsPrincipal principal, UserManager<User> users, SignInManager<User> signIn)
    {
        if (await users.GetUserAsync(principal) is not { } user) return TypedResults.Unauthorized();
        var result = await users.SetUserNameAsync(user, request.Username?.Trim());
        if (!result.Succeeded) return Invalid(result.Errors);
        await signIn.RefreshSignInAsync(user);
        return TypedResults.Ok(AccountResponse.From(user));
    }

    private static async Task<Results<NoContent, ValidationProblem, UnauthorizedHttpResult>> ChangePasswordAsync(
        ChangePasswordRequest request, ClaimsPrincipal principal, UserManager<User> users, SignInManager<User> signIn)
    {
        if (await users.GetUserAsync(principal) is not { } user) return TypedResults.Unauthorized();
        if (await CheckCurrentPasswordAsync(signIn, user, request.CurrentPassword, "currentPassword") is { } wrong) return wrong;

        var result = await users.ChangePasswordAsync(user, request.CurrentPassword ?? "", request.NewPassword ?? "");
        if (!result.Succeeded) return Invalid(result.Errors, passwordField: "newPassword");
        await signIn.RefreshSignInAsync(user); // the new security stamp signs out other sessions
        return TypedResults.NoContent();
    }

    // Permanent: the account and everything it owns. Later phases' tables cascade from the user.
    private static async Task<Results<NoContent, ValidationProblem, UnauthorizedHttpResult>> DeleteAsync(
        [FromBody] DeleteAccountRequest request, ClaimsPrincipal principal, UserManager<User> users, SignInManager<User> signIn)
    {
        if (await users.GetUserAsync(principal) is not { } user) return TypedResults.Unauthorized();
        if (await CheckCurrentPasswordAsync(signIn, user, request.Password, "password") is { } wrong) return wrong;

        var result = await users.DeleteAsync(user);
        if (!result.Succeeded) throw new InvalidOperationException($"Deleting user {user.Id} failed.");
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    // Re-confirming the password of a signed-in account counts towards the same lockout as logging in, so a
    // stolen session can't be used to guess the password (also rate limited, see MapAccountEndpoints).
    private static async Task<ValidationProblem?> CheckCurrentPasswordAsync(
        SignInManager<User> signIn, User user, string? password, string field)
    {
        var check = await signIn.CheckPasswordSignInAsync(user, password ?? "", lockoutOnFailure: true);
        if (check.Succeeded) return null;
        return Invalid(field, check.IsLockedOut
            ? "Too many wrong passwords. Try again in 15 minutes."
            : field == "currentPassword" ? "Current password is incorrect." : "Password is incorrect.");
    }

    private static async Task SendVerificationAsync(User user, UserManager<User> users, IAccountEmails emails, AccountLinks links)
    {
        var token = await users.GenerateEmailConfirmationTokenAsync(user);
        await emails.SendVerificationAsync(user, links.VerifyEmail(user.Id, token));
    }

    private static bool IsEmail(string email) =>
        email.Length <= 256 && MailAddress.TryCreate(email, out var address) && address.Address == email;

    private static ProblemHttpResult LinkProblem() => TypedResults.Problem(BadLink, statusCode: StatusCodes.Status400BadRequest);

    private static ValidationProblem Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });

    // Identity errors keyed by the form field they belong to. When Identity's built-in check and ours report the
    // same problem (same code), ours is registered last and wins.
    private static ValidationProblem Invalid(IEnumerable<IdentityError> errors, string passwordField = "password") =>
        TypedResults.ValidationProblem(errors
            .GroupBy(e => e.Code).Select(g => g.Last())
            .GroupBy(e => e.Code switch
            {
                _ when e.Code.StartsWith("Password") => passwordField,
                _ when e.Code.Contains("UserName") => "username",
                _ when e.Code.Contains("Email") => "email",
                _ => "",
            })
            .ToDictionary(g => g.Key, g => g.Select(e => e.Description).ToArray()));
}

public record RegisterRequest(string? Email, string? Username, string? Password);
public record LinkRequest(Guid UserId, string? Token);
public record EmailRequest(string? Email);
public record LoginRequest(string? Email, string? Password);
public record ResetPasswordRequest(Guid UserId, string? Token, string? Password);
public record ChangeUsernameRequest(string? Username);
public record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);
public record DeleteAccountRequest(string? Password);

public record AccountResponse(Guid Id, string Username, string Email)
{
    public static AccountResponse From(User user) => new(user.Id, user.UserName!, user.Email!);
}

// Links in account emails, built from the configured public address (never from the request's Host header).
public sealed class AccountLinks(IConfiguration configuration)
{
    private readonly string _baseUrl = (configuration["App:BaseUrl"]
        ?? throw new InvalidOperationException("Set App:BaseUrl to the site's public address.")).TrimEnd('/');

    public string Login() => $"{_baseUrl}/login";
    public string ForgotPassword() => $"{_baseUrl}/forgot-password";
    public string VerifyEmail(Guid userId, string token) => $"{_baseUrl}/verify-email?userId={userId}&token={Uri.EscapeDataString(token)}";
    public string ResetPassword(Guid userId, string token) => $"{_baseUrl}/reset-password?userId={userId}&token={Uri.EscapeDataString(token)}";
}
