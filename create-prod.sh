#!/bin/bash

create_github_package() {
  local version=$(grep -oE '"version": "[^"]*' manifest.json | cut -d '"' -f 4)
  echo "Creating GitHub package for version $version"
  # Assuming GitHub CLI is installed and authenticated
  gh release create "v$version" --title "Release v$version" --notes "Release version $version" --target main
  echo "GitHub package created for version $version"
}

create_github_package
