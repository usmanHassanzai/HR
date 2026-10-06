# Android build JDK requirement

Capacitor 7 / current Android modules require **JDK 21**.

This machine previously only had JDK 17; a temporary pin to Java 17 in `node_modules` and `capacitor.build.gradle` was used to compile once, then **reverted**.

## Setup

```bash
# Ubuntu/Debian
sudo apt-get install openjdk-21-jdk

export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
java -version   # should show 21

cd android
./gradlew :app:assembleDebug
```

Do **not** downgrade `sourceCompatibility` / `jvmToolchain` to 17 in Capacitor packages.
