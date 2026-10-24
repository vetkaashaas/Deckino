using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class CardPrices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "card_prices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    usd = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_etched = table.Column<decimal>(type: "numeric", nullable: true),
                    eur = table.Column<decimal>(type: "numeric", nullable: true),
                    eur_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    tix = table.Column<decimal>(type: "numeric", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_card_prices", x => x.id);
                    table.ForeignKey(
                        name: "fk_card_prices_cards_id",
                        column: x => x.id,
                        principalTable: "cards",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            // Every card's current prices move across; EF reads a card's prices from here.
            migrationBuilder.Sql(
                """
                INSERT INTO card_prices (id, usd, usd_foil, usd_etched, eur, eur_foil, tix)
                SELECT id, usd, usd_foil, usd_etched, eur, eur_foil, tix FROM cards
                """);

            // The history keeps only changes from now on: drop each day that repeats the printing's previous day.
            migrationBuilder.Sql(
                """
                DELETE FROM card_price_snapshots s
                USING (
                  SELECT scryfall_id, provider, date,
                    lag(date) OVER w IS NOT NULL
                      AND (usd, usd_foil, usd_etched, eur, eur_foil, tix) IS NOT DISTINCT FROM
                          (lag(usd) OVER w, lag(usd_foil) OVER w, lag(usd_etched) OVER w,
                           lag(eur) OVER w, lag(eur_foil) OVER w, lag(tix) OVER w) AS repeated
                  FROM card_price_snapshots
                  WINDOW w AS (PARTITION BY scryfall_id, provider ORDER BY date)
                ) r
                WHERE r.repeated AND s.scryfall_id = r.scryfall_id AND s.provider = r.provider AND s.date = r.date
                """);

            // The old snapshots skipped printings with no price at all, so one whose prices went away still ends on its
            // last price, and the import (which compares against card_prices) would never record the change: record it.
            migrationBuilder.Sql(
                """
                INSERT INTO card_price_snapshots (scryfall_id, provider, date, usd, usd_foil, usd_etched, eur, eur_foil, tix)
                SELECT p.id, 'scryfall', (now() AT TIME ZONE 'UTC')::date, p.usd, p.usd_foil, p.usd_etched, p.eur, p.eur_foil, p.tix
                FROM card_prices p
                LEFT JOIN LATERAL (
                  SELECT usd, usd_foil, usd_etched, eur, eur_foil, tix FROM card_price_snapshots s
                  WHERE s.scryfall_id = p.id AND s.provider = 'scryfall' ORDER BY s.date DESC LIMIT 1
                ) l ON true
                WHERE (p.usd, p.usd_foil, p.usd_etched, p.eur, p.eur_foil, p.tix)
                  IS DISTINCT FROM (l.usd, l.usd_foil, l.usd_etched, l.eur, l.eur_foil, l.tix)
                ON CONFLICT (scryfall_id, provider, date) DO UPDATE SET
                  usd = excluded.usd, usd_foil = excluded.usd_foil, usd_etched = excluded.usd_etched,
                  eur = excluded.eur, eur_foil = excluded.eur_foil, tix = excluded.tix
                """);

            migrationBuilder.DropColumn(
                name: "eur",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "eur_foil",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "tix",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "usd",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "usd_etched",
                table: "cards");

            migrationBuilder.DropColumn(
                name: "usd_foil",
                table: "cards");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<decimal>(
                name: "eur",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "eur_foil",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "tix",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "usd",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "usd_etched",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "usd_foil",
                table: "cards",
                type: "numeric",
                nullable: true);

            migrationBuilder.Sql(
                """
                UPDATE cards c SET usd = p.usd, usd_foil = p.usd_foil, usd_etched = p.usd_etched,
                  eur = p.eur, eur_foil = p.eur_foil, tix = p.tix
                FROM card_prices p WHERE p.id = c.id
                """);

            migrationBuilder.DropTable(
                name: "card_prices");
        }
    }
}
