using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class ArtworkIds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid[]>(
                name: "illustration_ids",
                table: "cards",
                type: "uuid[]",
                nullable: false,
                defaultValue: new Guid[0]);

            migrationBuilder.CreateIndex(
                name: "ix_cards_illustration_ids",
                table: "cards",
                column: "illustration_ids")
                .Annotation("Npgsql:IndexMethod", "gin");

            // The sync skips bulk data it has imported; this makes the next check import it again to fill the column.
            migrationBuilder.Sql("UPDATE catalogue_sync_runs SET error = 'Superseded: re-import for illustration_ids' WHERE error IS NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_cards_illustration_ids",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "illustration_ids",
                table: "cards");
        }
    }
}
