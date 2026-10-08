using System.Threading.RateLimiting;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;

namespace Deckino.Api.Accounts;

public static class AccountSetup
{
    public static IServiceCollection AddAccounts(this IServiceCollection services)
    {
        services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
        services.AddAuthorization();
        services
            .AddIdentityCore<User>(options =>
            {
                options.User.RequireUniqueEmail = true;
                options.User.AllowedUserNameCharacters = ""; // UsernameValidator owns the username rules
                // Length over composition rules (NIST 800-63B).
                options.Password.RequiredLength = 8;
                options.Password.RequiredUniqueChars = 1;
                options.Password.RequireDigit = false;
                options.Password.RequireLowercase = false;
                options.Password.RequireUppercase = false;
                options.Password.RequireNonAlphanumeric = false;
                options.Lockout.AllowedForNewUsers = true;
                options.Lockout.MaxFailedAccessAttempts = 5;
                options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
            })
            .AddUserValidator<UsernameValidator>()
            .AddPasswordValidator<PasswordLengthValidator>()
            .AddSignInManager()
            .AddEntityFrameworkStores<DeckinoDbContext>()
            .AddDefaultTokenProviders();

        services.ConfigureApplicationCookie(options =>
        {
            options.Cookie.Name = "deckino.auth";
            options.Cookie.HttpOnly = true;
            options.Cookie.SameSite = SameSiteMode.Lax;
            options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // HTTPS on Railway via X-Forwarded-Proto
            options.ExpireTimeSpan = TimeSpan.FromDays(30);
            options.SlidingExpiration = true;
            // An API answers with a status code, not a redirect to a login page.
            options.Events = new CookieAuthenticationEvents
            {
                OnRedirectToLogin = context => SetStatus(context.Response, StatusCodes.Status401Unauthorized),
                OnRedirectToAccessDenied = context => SetStatus(context.Response, StatusCodes.Status403Forbidden),
            };
        });
        // How soon a password change or deleted account ends other sessions.
        services.Configure<SecurityStampValidatorOptions>(options => options.ValidationInterval = TimeSpan.FromMinutes(5));

        services.AddDataProtection().SetApplicationName("Deckino").PersistKeysToDbContext<DeckinoDbContext>();

        services.AddSingleton<LogAccountEmails>();
        services.AddSingleton<IAccountEmails>(provider => provider.GetRequiredService<LogAccountEmails>());
        services.AddSingleton<SiteLinks>();

        services.AddRateLimiter(options =>
        {
            options.AddPolicy(AccountEndpoints.LoginLimit, context => PerClient(context, 10, TimeSpan.FromMinutes(1)));
            options.AddPolicy(AccountEndpoints.RegisterLimit, context => PerClient(context, 10, TimeSpan.FromHours(1)));
            options.AddPolicy(AccountEndpoints.PasswordCheckLimit, context => PerClient(context, 10, TimeSpan.FromMinutes(1)));
            options.AddPolicy(AccountEndpoints.EmailLimit, context => PerClient(context, 5, TimeSpan.FromMinutes(15)));
            options.OnRejected = async (context, ct) =>
            {
                // Logged so the partitioning can be checked: behind Railway this must be the visitor's IP.
                context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("RateLimit")
                    .LogWarning("Rate limit reached for {ClientIp} on {Path}",
                        context.HttpContext.Connection.RemoteIpAddress, context.HttpContext.Request.Path);
                context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
                await context.HttpContext.Response.WriteAsJsonAsync(new
                {
                    title = "Too many attempts. Wait a few minutes, then try again.",
                    status = StatusCodes.Status429TooManyRequests,
                }, ct);
            };
        });
        return services;
    }

    // Partitioned by client IP; behind Railway that is X-Real-IP (see UseForwardedHeaders in Program.cs).
    private static RateLimitPartition<string> PerClient(HttpContext context, int permits, TimeSpan window) =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = permits, Window = window });

    private static Task SetStatus(HttpResponse response, int status)
    {
        response.StatusCode = status;
        return Task.CompletedTask;
    }
}
