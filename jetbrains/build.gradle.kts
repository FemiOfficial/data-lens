plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "dev.datalens"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        instrumentationTools()
        pluginVerifier()
    }
}

kotlin { jvmToolchain(17) }

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "232"
            untilBuild = provider { null } // no upper bound
        }
    }
    buildSearchableOptions = false
    // `./gradlew verifyPlugin` — checks binary compatibility with the oldest supported and a current IDE.
    pluginVerification {
        ides {
            ide(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2023.2.8")
            ide(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2025.2")
        }
    }
}

// The web UI is built by `npm run build` in the repository root; fail fast if it's missing.
val webviewHtml = layout.projectDirectory.file("src/main/resources/webview/index.html").asFile
tasks.named("processResources") {
    doFirst {
        if (!webviewHtml.exists()) throw GradleException("Missing $webviewHtml — run `npm run build` in the repository root first.")
    }
}
