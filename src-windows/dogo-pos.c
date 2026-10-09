#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")

#define APP_TITLE L"Dogo POS Desktop"
#define LIVE_BASE_URL L"https://dogo-pos-app.netlify.app"
#define LOCAL_BASE_URL L"http://127.0.0.1:3000"

// Check if local Dogo POS server is listening on port 3000
static int IsLocalServerRunning(int port) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        return 0;
    }

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        WSACleanup();
        return 0;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = htons(port);

    // Set non-blocking mode for fast response
    u_long mode = 1;
    ioctlsocket(sock, FIONBIO, &mode);

    connect(sock, (struct sockaddr*)&addr, sizeof(addr));

    fd_set writeSet;
    FD_ZERO(&writeSet);
    FD_SET(sock, &writeSet);

    struct timeval timeout;
    timeout.tv_sec = 0;
    timeout.tv_usec = 250000; // 250 milliseconds

    int result = select(0, NULL, &writeSet, NULL, &timeout);
    closesocket(sock);
    WSACleanup();

    return (result > 0);
}

// Locate Microsoft Edge or Google Chrome executable for App Mode
static int FindChromiumBrowser(wchar_t* outPath, size_t maxLen) {
    wchar_t candidate[MAX_PATH];
    wchar_t progFiles[MAX_PATH];
    wchar_t progFiles86[MAX_PATH];
    wchar_t localAppData[MAX_PATH];

    GetEnvironmentVariableW(L"ProgramFiles", progFiles, MAX_PATH);
    GetEnvironmentVariableW(L"ProgramFiles(x86)", progFiles86, MAX_PATH);
    GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH);

    // 1. Check Microsoft Edge (pre-installed on all Windows 10 & 11)
    if (progFiles86[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", progFiles86);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }
    if (progFiles[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", progFiles);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }
    if (localAppData[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", localAppData);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }

    // 2. Check Google Chrome
    if (progFiles[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", progFiles);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }
    if (progFiles86[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", progFiles86);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }
    if (localAppData[0]) {
        swprintf(candidate, MAX_PATH, L"%ls\\Google\\Chrome\\Application\\chrome.exe", localAppData);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy(outPath, candidate, maxLen);
            return 1;
        }
    }

    return 0;
}

// Create a Desktop Shortcut for Dogo POS
static int CreateDesktopShortcut(void) {
    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    wchar_t desktopPath[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktopPath))) {
        return 0;
    }

    wchar_t shortcutPath[MAX_PATH];
    swprintf(shortcutPath, MAX_PATH, L"%ls\\Dogo POS.lnk", desktopPath);

    HRESULT hr = CoInitialize(NULL);
    IShellLinkW* psl = NULL;
    hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, &IID_IShellLinkW, (LPVOID*)&psl);
    if (SUCCEEDED(hr)) {
        psl->lpVtbl->SetPath(psl, exePath);
        psl->lpVtbl->SetDescription(psl, L"Dogo POS - Point of Sale Desktop Application");
        psl->lpVtbl->SetIconLocation(psl, exePath, 0);

        IPersistFile* ppf = NULL;
        hr = psl->lpVtbl->QueryInterface(psl, &IID_IPersistFile, (LPVOID*)&ppf);
        if (SUCCEEDED(hr)) {
            ppf->lpVtbl->Save(ppf, shortcutPath, TRUE);
            ppf->lpVtbl->Release(ppf);
        }
        psl->lpVtbl->Release(psl);
    }
    CoUninitialize();
    return SUCCEEDED(hr);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    // Check command line arguments
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    int forceLocal = 0;
    int forceLive = 0;
    int createShortcutOnly = 0;
    wchar_t subPath[128] = L"/dashboard.html";

    for (int i = 1; i < argc; i++) {
        if (_wcsicmp(argv[i], L"--retail") == 0 || _wcsicmp(argv[i], L"-r") == 0) {
            wcscpy(subPath, L"/sell.html");
        } else if (_wcsicmp(argv[i], L"--restaurant") == 0) {
            wcscpy(subPath, L"/restaurant.html");
        } else if (_wcsicmp(argv[i], L"--dashboard") == 0) {
            wcscpy(subPath, L"/dashboard.html");
        } else if (_wcsicmp(argv[i], L"--admin") == 0) {
            wcscpy(subPath, L"/admin");
        } else if (_wcsicmp(argv[i], L"--inventory") == 0) {
            wcscpy(subPath, L"/inventory.html");
        } else if (_wcsicmp(argv[i], L"--reports") == 0) {
            wcscpy(subPath, L"/reports.html");
        } else if (_wcsicmp(argv[i], L"--local") == 0) {
            forceLocal = 1;
        } else if (_wcsicmp(argv[i], L"--live") == 0) {
            forceLive = 1;
        } else if (_wcsicmp(argv[i], L"--shortcut") == 0 || _wcsicmp(argv[i], L"--install-shortcut") == 0) {
            createShortcutOnly = 1;
        } else if (_wcsicmp(argv[i], L"--help") == 0 || _wcsicmp(argv[i], L"/?") == 0) {
            MessageBoxW(NULL,
                L"Dogo POS for Windows v1.0\n\n"
                L"Available Options:\n"
                L"  (default)           Launch Dogo POS Desktop App\n"
                L"  --retail, -r        Launch Direct Retail POS Cashier\n"
                L"  --restaurant        Launch Restaurant POS Dining & Kitchen\n"
                L"  --dashboard         Launch Management Dashboard\n"
                L"  --admin             Launch Admin Console\n"
                L"  --inventory         Launch Inventory Management\n"
                L"  --reports           Launch Sales & Financial Reports\n"
                L"  --local             Force connection to localhost:3000\n"
                L"  --live              Force connection to live Netlify cloud\n"
                L"  --shortcut          Create Desktop Shortcut icon\n\n"
                L"Features:\n"
                L"- Clean frameless desktop window (App Mode)\n"
                L"- Barcode scanner hardware support (USB/Wireless)\n"
                L"- ESC/POS thermal receipt printing support\n"
                L"- Offline & Online data synchronization\n"
                L"- Isolated POS profile cache",
                APP_TITLE,
                MB_OK | MB_ICONINFORMATION);
            LocalFree(argv);
            return 0;
        }
    }

    if (createShortcutOnly) {
        if (CreateDesktopShortcut()) {
            MessageBoxW(NULL, L"Dogo POS desktop shortcut created successfully!", APP_TITLE, MB_OK | MB_ICONINFORMATION);
        } else {
            MessageBoxW(NULL, L"Unable to create desktop shortcut.", APP_TITLE, MB_OK | MB_ICONWARNING);
        }
        LocalFree(argv);
        return 0;
    }

    // Determine target URL
    wchar_t targetUrl[512];
    if (forceLocal) {
        swprintf(targetUrl, 512, L"%ls%ls", LOCAL_BASE_URL, subPath);
    } else if (forceLive) {
        swprintf(targetUrl, 512, L"%ls%ls", LIVE_BASE_URL, subPath);
    } else {
        // Auto-detect: if local server is active, prefer local; otherwise use live cloud
        if (IsLocalServerRunning(3000)) {
            swprintf(targetUrl, 512, L"%ls%ls", LOCAL_BASE_URL, subPath);
        } else {
            swprintf(targetUrl, 512, L"%ls%ls", LIVE_BASE_URL, subPath);
        }
    }

    // Auto-create desktop shortcut on first run if it does not exist yet
    wchar_t desktopPath[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktopPath))) {
        wchar_t testShortcut[MAX_PATH];
        swprintf(testShortcut, MAX_PATH, L"%ls\\Dogo POS.lnk", desktopPath);
        if (GetFileAttributesW(testShortcut) == INVALID_FILE_ATTRIBUTES) {
            CreateDesktopShortcut();
        }
    }

    // Try to launch in Chromium App Mode for native borderless window feel
    wchar_t browserPath[MAX_PATH];
    if (FindChromiumBrowser(browserPath, MAX_PATH)) {
        wchar_t localAppData[MAX_PATH];
        GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, MAX_PATH);

        wchar_t profileDir[MAX_PATH];
        if (localAppData[0]) {
            swprintf(profileDir, MAX_PATH, L"%ls\\DogoPOS\\Profile", localAppData);
        } else {
            swprintf(profileDir, MAX_PATH, L"DogoPOSProfile");
        }

        wchar_t launchArgs[1024];
        // --app gives frameless app window, with custom user-data-dir and optimal POS window size
        swprintf(launchArgs, 1024,
            L"\"%ls\" --app=\"%ls\" --window-size=1366,850 --window-position=50,50 --user-data-dir=\"%ls\" --disable-features=Translate",
            browserPath, targetUrl, profileDir);

        STARTUPINFOW si;
        PROCESS_INFORMATION pi;
        memset(&si, 0, sizeof(si));
        memset(&pi, 0, sizeof(pi));
        si.cb = sizeof(si);

        if (CreateProcessW(NULL, launchArgs, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            LocalFree(argv);
            return 0;
        }
    }

    // Fallback: open via system default browser
    ShellExecuteW(NULL, L"open", targetUrl, NULL, NULL, SW_SHOWNORMAL);

    LocalFree(argv);
    return 0;
}
