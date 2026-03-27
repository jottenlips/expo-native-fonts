# expo-native-fonts

This module is for adding custom fonts to native iOS extensions, for example if you use my [expo widgets module](https://github.com/gitn00b1337/expo-widgets).

## Installation

```
npx expo install @bittingz/expo-native-fonts
```

## Setup

To add fonts, simply create a folder and drop iOS compatible fonts (e.g. ttf files) in there. Then add the following to your expo app.config.(ts/js) plugins array:

```
"@bittingz/expo-native-fonts",
    {
        "srcFolder": "./fonts",
            "fonts": [
            {
                "filePath": "Montserrat/Montserrat-Bold.ttf",
                "targets": [
                    "expowidgetsWidgetExtension"
                ],
                "platform": "ios"
            }
        ]
    }
```

srcFolder should relative path from your project root to the fonts folder.
fonts is an array of fonts to inject

Each item of fonts must have the file path, the targets it is to be injected into and the platform. Android is not yet supported.

## Plugin Ordering

If your target is created by another config plugin (e.g. `@bittingz/expo-widgets`), `@bittingz/expo-native-fonts` **must be listed before** the plugin that creates the target. Expo's mod system executes `withXcodeProject` callbacks in reverse registration order (LIFO), so the plugin listed last runs first.

```
// ✅ Correct - expo-widgets is listed last so it runs first and creates the target
["@bittingz/expo-native-fonts", { ... }],
["@bittingz/expo-widgets", { ... }],

// ❌ Wrong - expo-native-fonts runs first, target doesn't exist yet
["@bittingz/expo-widgets", { ... }],
["@bittingz/expo-native-fonts", { ... }],
```
