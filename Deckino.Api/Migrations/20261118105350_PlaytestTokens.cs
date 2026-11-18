using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class PlaytestTokens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid[]>(
                name: "token_ids",
                table: "cards",
                type: "uuid[]",
                nullable: false,
                defaultValue: new Guid[0]);
            // The sync skips bulk data it already imported; without this, token_ids stay empty until Scryfall's next file.
            // Only the newest file's runs: older ones never stop a sync, and the admin page's history stays true.
            migrationBuilder.Sql(
                "UPDATE catalogue_sync_runs SET error = 'Superseded: re-import for token_ids' " +
                "WHERE error IS NULL AND finished_at IS NOT NULL AND bulk_updated_at = (SELECT max(bulk_updated_at) FROM catalogue_sync_runs);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "token_ids",
                table: "cards");
        }
    }
}
