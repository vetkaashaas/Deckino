using System.Windows;
using Deckino.Tools.Data;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var database = new Database(Database.ResolveDefaultPath());
        database.Initialize();

        var window = new MainWindow
        {
            DataContext = new ShellViewModel(
                new SyncViewModel(),
                new AnnotatorViewModel(),
                new RunnerViewModel()),
        };
        window.Show();
    }
}
