# LLM Guardian

LLM Guardian is a Chrome Extension designed to redact secrets from the ChatGPT prompt box before they get sent to OpenAI. This ensures that sensitive information is not inadvertently shared. It requires our hosted version at llmsecrets.com or an open-source backend server to function effectively.

## Features

- Automatically redacts secrets from the ChatGPT prompt box.
- Easy to use interface with simple setup.
- Secure storage of API keys using Chrome's local storage.

## Installation

1. Clone the repository or download the ZIP file.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" by toggling the switch in the top right corner.
4. Click on "Load unpacked" and select the directory where you cloned or extracted the extension.

## Usage

1. Click on the LLM Guardian icon in the Chrome toolbar.
2. Enter your API key in the provided input field and click "Save".
3. The extension will automatically redact secrets from the ChatGPT prompt box.

## Development

### Prerequisites

- Node.js
- npm

### Setup

1. Install the dependencies:
    ```bash
    npm install
    ```

2. Build the extension:
    ```bash
    npm run build
    ```

3. Load the extension in Chrome as described in the Installation section.

## Contributing

We welcome contributions! Please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [detect-secrets](https://github.com/Yelp/detect-secrets) for secret detection.

## Contact

For any inquiries or support, please contact us at support@llmguardian.com.
