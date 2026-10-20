using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using System.Windows.Input;
using CommunityToolkit.Mvvm.Input;

namespace Deckino.Toolbox.Bridge;

/// <summary>
/// Turns a view model into what the React page renders: its public properties as JSON (<c>state</c>) and which of
/// its commands can run now (<c>commands</c>, keyed by the command's name without "Command", camelCase). Commands,
/// tasks and bitmaps are left out of the state. Paths such as <c>selected.name</c> address nested values.
/// </summary>
public static class StateSerializer
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver { Modifiers = { StateContract } },
    };

    private static readonly ConcurrentDictionary<Type, (string Name, PropertyInfo Property)[]> Commands = new();
    // Per workspace (the object a snapshot is taken of), and weakly: nothing is kept alive by having been watched.
    private static readonly ConditionalWeakTable<object, Counter> Counters = new();
    private static readonly ConditionalWeakTable<object, List<Counter>> Watching = new();
    [ThreadStatic] private static Counter? _snapshotting;

    private sealed class Counter
    {
        public long Changes, Responses;
    }

    /// <summary>
    /// How often anything this workspace's snapshot included has changed (a property, a collection, whether a command
    /// can run: the view models raise these for everything they show, as MAUI's bindings needed), and how often a
    /// response has handed the page its state.
    /// </summary>
    public static (long Changes, long Responses) VersionOf(object root)
    {
        var counter = CounterOf(root);
        return (Interlocked.Read(ref counter.Changes), Interlocked.Read(ref counter.Responses));
    }

    /// <summary>For state that raises no change events of its own.</summary>
    public static void Changed(object root) => Interlocked.Increment(ref CounterOf(root).Changes);

    public static void Responded(object root) => Interlocked.Increment(ref CounterOf(root).Responses);

    private static Counter CounterOf(object root) => Counters.GetValue(root, static _ => new Counter());

    public static string Snapshot(object target)
    {
        _snapshotting = CounterOf(target);
        try
        {
            var commands = new Dictionary<string, bool>();
            foreach (var (name, property) in CommandsOf(target.GetType()))
            {
                if (property.GetValue(target) is not ICommand command) continue;
                Watch(command);
                commands[name] = command.CanExecute(null);
            }
            return JsonSerializer.Serialize(new { state = target, commands }, Options);
        }
        finally
        {
            _snapshotting = null;
        }
    }

    // Counts the value's changes for the workspace being serialized.
    private static void Watch(object value)
    {
        if (_snapshotting is not { } counter
            || value is not (INotifyPropertyChanged or INotifyCollectionChanged or ICommand)) return;
        var counters = Watching.GetValue(value, static _ => []);
        if (counters.Contains(counter)) return;
        counters.Add(counter);
        void Changed(object? sender, EventArgs args) => Interlocked.Increment(ref counter.Changes);
        if (value is INotifyPropertyChanged notifying) notifying.PropertyChanged += Changed;
        if (value is INotifyCollectionChanged collection) collection.CollectionChanged += Changed;
        if (value is ICommand command) command.CanExecuteChanged += Changed;
    }

    public static (ICommand Command, object? Parameter) PrepareCommand(object target, string name, JsonElement? argument)
    {
        var property = target.GetType().GetProperty(name + "Command",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)
            ?? throw new KeyNotFoundException($"{target.GetType().Name} has no command {name}.");
        var command = (ICommand)property.GetValue(target)!;
        var parameterType = command.GetType().GetInterfaces()
            .FirstOrDefault(type => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IRelayCommand<>))
            ?.GetGenericArguments()[0];
        var parameter = parameterType is null || argument is not { ValueKind: not (JsonValueKind.Undefined or JsonValueKind.Null) } value
            ? null
            : ConvertValue(target, value, parameterType);
        return (command, parameter);
    }

    /// <summary>
    /// Sets each <c>path: value</c> pair. A value <c>{"$ref": "selected"}</c> picks an existing object; one in a list is
    /// picked by its values, <c>{"$ref": "runs", "where": {"run.modelVersion": "x"}}</c>, as a position could point at
    /// another item once the list has been rebuilt.
    /// </summary>
    public static void Patch(object target, JsonElement changes)
    {
        foreach (var change in changes.EnumerateObject())
        {
            var path = change.Name;
            var split = path.LastIndexOf('.');
            var owner = split < 0 ? target : Resolve(target, path[..split])
                ?? throw new KeyNotFoundException($"Nothing at {path[..split]}.");
            var property = FindProperty(owner.GetType(), split < 0 ? path : path[(split + 1)..]);
            if (property?.SetMethod is not { IsPublic: true })
                throw new InvalidOperationException($"{path} cannot be changed.");
            property.SetValue(owner, ConvertValue(target, change.Value, property.PropertyType));
        }
    }

    public static object? Resolve(object root, string path)
    {
        object? current = root;
        foreach (var segment in path.Split('.'))
        {
            if (current is null) return null;
            if (current is IList list && int.TryParse(segment, out var index))
            {
                current = index >= 0 && index < list.Count ? list[index] : null;
                continue;
            }
            current = (FindProperty(current.GetType(), segment)
                ?? throw new KeyNotFoundException($"Nothing at {path}.")).GetValue(current);
        }
        return current;
    }

    private static object? ConvertValue(object root, JsonElement value, Type type)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("$ref", out var reference))
            return value.Deserialize(type, Options);
        var path = reference.GetString() ?? string.Empty;
        var found = Resolve(root, path);
        if (!value.TryGetProperty("where", out var where)) return found;
        return (found as IEnumerable)?.Cast<object>().FirstOrDefault(item => Matches(item, where))
            ?? throw new KeyNotFoundException($"That item is no longer in {path}.");
    }

    private static bool Matches(object item, JsonElement where) => where.EnumerateObject().All(condition =>
        Resolve(item, condition.Name) is var actual && (actual is null
            ? condition.Value.ValueKind == JsonValueKind.Null
            : Equals(actual, condition.Value.Deserialize(actual.GetType(), Options))));

    private static PropertyInfo? FindProperty(Type type, string name) =>
        type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);

    private static (string Name, PropertyInfo Property)[] CommandsOf(Type type) => Commands.GetOrAdd(type, static type =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => typeof(ICommand).IsAssignableFrom(property.PropertyType) && property.Name.EndsWith("Command"))
            .Select(property => (JsonNamingPolicy.CamelCase.ConvertName(property.Name[..^"Command".Length]), property))
            .ToArray());

    // Leaves out what isn't state, and watches every object and collection a snapshot includes (see Changes).
    private static void StateContract(JsonTypeInfo info)
    {
        if (info.Kind != JsonTypeInfoKind.Object) return;
        info.OnSerializing = Watch;
        for (var index = info.Properties.Count - 1; index >= 0; index--)
        {
            var property = info.Properties[index];
            var type = property.PropertyType;
            if (typeof(ICommand).IsAssignableFrom(type) || typeof(Delegate).IsAssignableFrom(type)
                || typeof(Task).IsAssignableFrom(type) || typeof(System.Drawing.Image).IsAssignableFrom(type)
                || typeof(Stream).IsAssignableFrom(type))
                info.Properties.RemoveAt(index);
            else if (type != typeof(string) && typeof(IEnumerable).IsAssignableFrom(type) && property.Get is { } get)
                property.Get = owner =>
                {
                    var value = get(owner);
                    if (value is not null) Watch(value);
                    return value;
                };
        }
    }
}
