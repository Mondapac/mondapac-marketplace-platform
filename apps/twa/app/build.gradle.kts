plugins {
    id("com.android.application")
}

val twaHost: String = (project.findProperty("twaHost") as String?) ?: "mondapac.com.au"

android {
    namespace = "au.com.mondapac.store"
    compileSdk = 35

    defaultConfig {
        applicationId = "au.com.mondapac.store"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        manifestPlaceholders["twaHost"] = twaHost
        resValue("string", "twa_host", twaHost)
        resValue("string", "twa_start_url", "/")
        resValue("string", "asset_statements",
            "[{\"relation\":[\"delegate_permission/common.handle_all_urls\"],\"target\":{\"namespace\":\"web\",\"site\":\"https://$twaHost\"}}]")
    }

    buildTypes {
        // Release signing is deliberately not configured here: the upload key stays with john
        // and never enters the repository. Sign the release bundle outside the repo.
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
