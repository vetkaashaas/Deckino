namespace Deckino.Api;

// The site's public address (App:BaseUrl) and the links built from it: account emails and link previews.
// Never the request's Host header, which the client controls.
public sealed class SiteLinks(IConfiguration configuration)
{
    public string BaseUrl { get; } = (configuration["App:BaseUrl"]
        ?? throw new InvalidOperationException("Set App:BaseUrl to the site's public address.")).TrimEnd('/');

    public string Login() => $"{BaseUrl}/login";
    public string ForgotPassword() => $"{BaseUrl}/forgot-password";
    public string VerifyEmail(Guid userId, string token) => $"{BaseUrl}/verify-email?userId={userId}&token={Uri.EscapeDataString(token)}";
    public string ResetPassword(Guid userId, string token) => $"{BaseUrl}/reset-password?userId={userId}&token={Uri.EscapeDataString(token)}";
}
