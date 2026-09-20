'use strict';

module.exports = {
    env: {
        EXPO_APP_NAME: 'ToAgent Remote',
        EXPO_APP_SLUG: 'toagent-remote',
        EXPO_APP_BUNDLE_ID: 'io.toagent.remote',
        EXPO_ANDROID_PACKAGE: 'io.toagent.remote',
        EXPO_APP_SCHEME: 'toagent-remote',
        EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://twin-control.tail46137f.ts.net',
        HAPPIER_ANDROID_USES_CLEARTEXT_TRAFFIC: 'false',
    },
    expo: {
        android: {
            googleServicesFile: null,
        },
        updates: {
            enabled: false,
            checkAutomatically: 'NEVER',
            fallbackToCacheTimeout: 0,
            url: 'https://updates.toagent.invalid',
        },
        extra: {
            eas: null,
        },
    },
};
