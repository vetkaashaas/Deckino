using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class CardCatalogue : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Phase 1's history table: always empty, superseded by the snake_case __ef_migrations_history.
            migrationBuilder.Sql("DROP TABLE IF EXISTS \"__EFMigrationsHistory\";");

            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:PostgresExtension:pg_trgm", ",,");

            migrationBuilder.CreateTable(
                name: "cards",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    oracle_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    lang = table.Column<string>(type: "text", nullable: false),
                    released_at = table.Column<DateOnly>(type: "date", nullable: false),
                    layout = table.Column<string>(type: "text", nullable: false),
                    mana_cost = table.Column<string>(type: "text", nullable: true),
                    mana_value = table.Column<decimal>(type: "numeric", nullable: false),
                    type_line = table.Column<string>(type: "text", nullable: true),
                    oracle_text = table.Column<string>(type: "text", nullable: true),
                    power = table.Column<string>(type: "text", nullable: true),
                    toughness = table.Column<string>(type: "text", nullable: true),
                    loyalty = table.Column<string>(type: "text", nullable: true),
                    colors = table.Column<string[]>(type: "text[]", nullable: false),
                    color_identity = table.Column<string[]>(type: "text[]", nullable: false),
                    keywords = table.Column<string[]>(type: "text[]", nullable: false),
                    set_code = table.Column<string>(type: "text", nullable: false),
                    set_name = table.Column<string>(type: "text", nullable: false),
                    set_type = table.Column<string>(type: "text", nullable: false),
                    collector_number = table.Column<string>(type: "text", nullable: false),
                    rarity = table.Column<string>(type: "text", nullable: false),
                    artist = table.Column<string>(type: "text", nullable: true),
                    flavor_text = table.Column<string>(type: "text", nullable: true),
                    legal_formats = table.Column<string[]>(type: "text[]", nullable: false),
                    banned_formats = table.Column<string[]>(type: "text[]", nullable: false),
                    restricted_formats = table.Column<string[]>(type: "text[]", nullable: false),
                    full_art = table.Column<bool>(type: "boolean", nullable: false),
                    promo = table.Column<bool>(type: "boolean", nullable: false),
                    digital = table.Column<bool>(type: "boolean", nullable: false),
                    oversized = table.Column<bool>(type: "boolean", nullable: false),
                    finishes = table.Column<string[]>(type: "text[]", nullable: false),
                    usd = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_etched = table.Column<decimal>(type: "numeric", nullable: true),
                    eur = table.Column<decimal>(type: "numeric", nullable: true),
                    eur_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    tix = table.Column<decimal>(type: "numeric", nullable: true),
                    is_default_printing = table.Column<bool>(type: "boolean", nullable: false),
                    is_missing_upstream = table.Column<bool>(type: "boolean", nullable: false),
                    faces = table.Column<string>(type: "jsonb", nullable: true),
                    images = table.Column<string>(type: "jsonb", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cards", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "catalogue_sync_runs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    bulk_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    cards_read = table.Column<int>(type: "integer", nullable: false),
                    digital_skipped = table.Column<int>(type: "integer", nullable: false),
                    inserted = table.Column<int>(type: "integer", nullable: false),
                    updated = table.Column<int>(type: "integer", nullable: false),
                    missing_upstream = table.Column<int>(type: "integer", nullable: false),
                    error = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_catalogue_sync_runs", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_cards_name",
                table: "cards",
                column: "name")
                .Annotation("Npgsql:IndexMethod", "gin")
                .Annotation("Npgsql:IndexOperators", new[] { "gin_trgm_ops" });

            migrationBuilder.CreateIndex(
                name: "ix_cards_oracle_id",
                table: "cards",
                column: "oracle_id");

            migrationBuilder.CreateIndex(
                name: "ix_cards_set_code",
                table: "cards",
                column: "set_code");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "cards");

            migrationBuilder.DropTable(
                name: "catalogue_sync_runs");
        }
    }
}
