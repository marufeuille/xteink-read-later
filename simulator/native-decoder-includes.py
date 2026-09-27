Import("env")

# include_next in the simulator JPEGDEC/PNGdec shims only sees directories
# after the shim header. Library include paths are often earlier, so append
# the native decoder headers explicitly.
env.Append(
    CPPPATH=[
        env.subst("$PROJECT_LIBDEPS_DIR/$PIOENV/JPEGDEC/src"),
        env.subst("$PROJECT_LIBDEPS_DIR/$PIOENV/PNGdec/src"),
    ]
)
