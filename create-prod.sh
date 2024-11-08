#!/bin/bash

# Function to update content.js for production
update_content_js() {
  sed -i 's/const LOG_LEVEL = .*/const LOG_LEVEL = '\''ERROR'\'';/' content.js
  sed -i 's/const isDev = .*/const isDev = false;/' content.js
}

# Function to rollback content.js to development
rollback_content_js() {
  sed -i 's/const LOG_LEVEL = .*/const LOG_LEVEL = '\''DEBUG'\'';/' content.js
  sed -i 's/const isDev = .*/const isDev = chrome.runtime.getManifest().version_name.includes('\''dev'\'');/' content.js
}

# Function to update the manifest version
update_manifest_version() {
  local version=$(grep -oP '(?<="version": ")[^"]*' manifest.json)
  local version_name=$(grep -oP '(?<="version_name": ")[^"]*' manifest.json)
  echo "Updating manifest version to $version ($version_name)"
}

# Function to rollback manifest changes
rollback_manifest_version() {
  # Assuming we have a backup of the original manifest.json
  cp manifest.json.bak manifest.json
  echo "Manifest changes rolled back"
}

# Function to bundle the extension into a zip file
bundle_extension() {
  local version=$(grep -oP '(?<="version": ")[^"]*' manifest.json)
  local zip_name="chrome-extension-v$version.zip"
  zip -r $zip_name . -x "*.git*" "*.DS_Store"
  echo "Extension bundled into $zip_name"
}

# Function to create a GitHub package
create_github_package() {
  local version=$(grep -oP '(?<="version": ")[^"]*' manifest.json)
  echo "Creating GitHub package for version $version"
  # Assuming GitHub CLI is installed and authenticated
  gh release create "v$version" --title "Release v$version" --notes "Release version $version" --target main
  echo "GitHub package created for version $version"
}

# Main script execution
update_content_js
update_manifest_version
bundle_extension
create_github_package
rollback_content_js
rollback_manifest_version