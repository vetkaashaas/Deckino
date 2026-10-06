# Deckino web service: ASP.NET API serving the built React site.

FROM node:22-alpine AS web
WORKDIR /src/Deckino.Web
COPY Deckino.Web/package.json Deckino.Web/package-lock.json ./
RUN npm ci
COPY Deckino.Web/ ./
# Vite writes the build to ../Deckino.Api/wwwroot.
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src/Deckino.Api
COPY Deckino.Api/Deckino.Api.csproj ./
RUN dotnet restore
COPY Deckino.Api/ ./
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /app ./
COPY --from=web /src/Deckino.Api/wwwroot ./wwwroot
ENTRYPOINT ["dotnet", "Deckino.Api.dll"]
