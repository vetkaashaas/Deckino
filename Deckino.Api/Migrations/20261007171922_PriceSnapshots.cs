using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Deckino.Api.Migrations
{
    /// <inheritdoc />
    public partial class PriceSnapshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "card_price_snapshots",
                columns: table => new
                {
                    scryfall_id = table.Column<Guid>(type: "uuid", nullable: false),
                    provider = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    date = table.Column<DateOnly>(type: "date", nullable: false),
                    usd = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    usd_etched = table.Column<decimal>(type: "numeric", nullable: true),
                    eur = table.Column<decimal>(type: "numeric", nullable: true),
                    eur_foil = table.Column<decimal>(type: "numeric", nullable: true),
                    tix = table.Column<decimal>(type: "numeric", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_card_price_snapshots", x => new { x.scryfall_id, x.provider, x.date });
                });

            migrationBuilder.CreateIndex(
                name: "ix_card_price_snapshots_date",
                table: "card_price_snapshots",
                column: "date");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "card_price_snapshots");
        }
    }
}
