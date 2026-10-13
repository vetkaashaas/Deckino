using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class BinderPrintingConfirmed : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "printing_confirmed",
                table: "binder_cards",
                type: "boolean",
                nullable: false,
                defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "printing_confirmed",
                table: "binder_cards");
        }
    }
}
