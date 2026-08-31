using System.Windows;
using System.Windows.Controls;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class DatasetSyncView : UserControl
{
    public DatasetSyncView() => InitializeComponent();

    private void OnSecretAccessKeyChanged(object sender, RoutedEventArgs e)
    {
        if (DataContext is DatasetSyncViewModel viewModel && sender is PasswordBox passwordBox)
            viewModel.SecretAccessKey = passwordBox.Password;
    }
}
