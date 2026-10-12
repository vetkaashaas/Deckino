using System.Collections.Concurrent;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;

namespace Deckino.Api.Accounts;

public sealed record RenderedEmail(string Tag, string Subject, string Html, string Text);

// Renders the account emails from the templates in Accounts/EmailTemplates (embedded in the assembly): a shared
// layout, one HTML and one plain-text body per email, and the button and fallback-link partials. Every value is
// HTML-encoded on the way into HTML. A {{placeholder}} without a value throws, so a template typo fails loudly
// (the E2E run renders every template through /api/dev/emails).
public sealed partial class AccountEmailTemplates(SiteLinks links)
{
    public const string SupportEmail = "support@deckino.com";
    public static readonly string[] Names = ["verify-email", "reset-password", "already-registered"];

    private static readonly ConcurrentDictionary<string, string> Files = new();

    public RenderedEmail Verification(string username, string link) =>
        Render("verify-email", "Verify your email", "One click to finish creating your Deckino account.",
            "Verify my email", link, new() { ["username"] = username });

    public RenderedEmail PasswordReset(string username, string link) =>
        Render("reset-password", "Reset your password", "Choose a new password for your Deckino account.",
            "Choose a new password", link, new() { ["username"] = username });

    public RenderedEmail AlreadyRegistered(string username, string loginLink, string resetLink) =>
        Render("already-registered", "You already have a Deckino account", "Someone tried to sign up with your email address.",
            "Log in to Deckino", loginLink, new() { ["username"] = username, ["resetLink"] = resetLink });

    // Sample data for the development-only previews.
    public RenderedEmail? Sample(string name) => name switch
    {
        "verify-email" => Verification("Jace_Beleren", links.VerifyEmail(Guid.Empty, "sample-token")),
        "reset-password" => PasswordReset("Jace_Beleren", links.ResetPassword(Guid.Empty, "sample-token")),
        "already-registered" => AlreadyRegistered("Jace_Beleren", links.Login(), links.ForgotPassword()),
        _ => null,
    };

    private RenderedEmail Render(string name, string subject, string preheader, string buttonLabel, string link,
        Dictionary<string, string> values)
    {
        values["link"] = link;
        var html = values.ToDictionary(v => v.Key, v => Encode(v.Value));
        html["button"] = Fill("button.html", new() { ["link"] = Encode(link), ["label"] = Encode(buttonLabel) });
        html["fallback"] = Fill("fallback.html", new() { ["link"] = Encode(link) });

        var page = Fill("layout.html", new()
        {
            ["subject"] = Encode(subject),
            ["preheader"] = Encode(preheader),
            ["siteUrl"] = Encode(links.BaseUrl),
            ["logoUrl"] = Encode($"{links.BaseUrl}/email/logo.png"),
            ["supportEmail"] = Encode(SupportEmail),
            ["content"] = Fill($"{name}.html", html),
        });
        var text = Fill($"{name}.txt", values)
            + $"\n--\nDeckino · {links.BaseUrl}\nQuestions? Reply to this email or write to {SupportEmail}.\n";
        return new RenderedEmail(name, subject, page, text);
    }

    // One pass, so a value that happens to contain "{{…}}" is never expanded itself.
    private static string Fill(string file, Dictionary<string, string> values) =>
        Placeholder().Replace(Load(file), match => values.TryGetValue(match.Groups[1].Value, out var value)
            ? value
            : throw new InvalidOperationException($"Email template {file} uses {match.Value}, which has no value."));

    private static string Encode(string value) => HtmlEncoder.Default.Encode(value);

    private static string Load(string file) => Files.GetOrAdd(file, f =>
    {
        using var stream = typeof(AccountEmailTemplates).Assembly.GetManifestResourceStream($"EmailTemplates/{f}")
            ?? throw new InvalidOperationException($"Email template {f} is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    [GeneratedRegex(@"\{\{(\w+)\}\}")]
    private static partial Regex Placeholder();
}
