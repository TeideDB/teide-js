cmake_minimum_required(VERSION 3.15)
project(teidedb_addon LANGUAGES C CXX)

# C core: C17
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# Addon: C++17 (required by node-addon-api)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(TEIDE_PORTABLE "Build portable binary (no -march=native)" OFF)

# ---- Teide C core (static lib) ----
file(GLOB_RECURSE TEIDE_SOURCES CONFIGURE_DEPENDS "vendor/teide/src/**/*.c")
add_library(teide_core STATIC ${TEIDE_SOURCES})
set_target_properties(teide_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(teide_core PUBLIC vendor/teide/include PRIVATE vendor/teide/src)

if(MSVC)
    target_compile_options(teide_core PRIVATE /O2 /DNDEBUG)
else()
    if(TEIDE_PORTABLE)
        target_compile_options(teide_core PRIVATE -O3 -mtune=generic -DNDEBUG)
    else()
        target_compile_options(teide_core PRIVATE -O3 -march=native -DNDEBUG)
    endif()
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_libraries(teide_core PUBLIC m pthread)
endif()

# ---- NAPI addon ----
file(GLOB_RECURSE ADDON_SOURCES CONFIGURE_DEPENDS "src/*.cpp")

# cmake-js provides: CMAKE_JS_INC, CMAKE_JS_LIB, CMAKE_JS_SRC
include_directories(${CMAKE_JS_INC})
add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} PRIVATE teide_core ${CMAKE_JS_LIB})

# node-addon-api headers
execute_process(
    COMMAND node -p "require('node-addon-api').include_dir"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NAPI_INCLUDE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
target_include_directories(${PROJECT_NAME} PRIVATE ${NAPI_INCLUDE_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=9 NAPI_DISABLE_CPP_EXCEPTIONS)
