const crypto = require("crypto");
const { promisify } = require("util");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/appError");
const Seller = require("../models/sellerModel");
const Email = require("./../utils/email");

const signToken = (id) => {
  return jwt.sign({ id: id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, req, res) => {
  const token = signToken(user._id);

  res.cookie("jwt", token, {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
  });

  user.password = undefined;

  res.status(statusCode).json({
    status: "success",
    token,
    data: {
      user: user,
    },
  });
};

exports.signup = (Model) =>
  catchAsync(async (req, res, next) => {
    if (await Model.findOne({ email: req.body.email })) {
      return next(new AppError("Email already exists! Use different.", 400));
    }

    const newDoc = await Model.create({
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      photo: req.body.photo,
      password: req.body.password,
      passwordConfirm: req.body.passwordConfirm,
    });

    const signupToken = newDoc.createSignupToken();
    await newDoc.save({ validateBeforeSave: false });

    try {
      const signupURL = `${req.protocol}://${req.get("host")}/api/v1/${
        newDoc.role
      }s/emailConfirmation/${signupToken}`;

      await new Email(newDoc, signupURL).sendWelcome();

      res.status(200).json({
        status: "success",
        message: "Token sent to your email, Verify your email.",
      });
    } catch (err) {
      console.log("ERROR", err);
      newDoc.emailConfirmationToken = undefined;
      newDoc.emailConfirmationExpires = undefined;
      await newDoc.delete();

      return next(
        new AppError(
          "There was an error creating your account. Try again later!"
        ),
        500
      );
    }
  });

exports.emailConfirmation = (Model) =>
  catchAsync(async (req, res, next) => {
    // Getting user or seller based on token
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await Model.findOne({
      emailConfirmationToken: hashedToken,
      emailConfirmationExpires: { $gt: Date.now() },
    });

    if (!user) {
      return next(new AppError("Token is Invalid or has expired!", 400));
    }

    user.emailConfirmed = true;
    user.active = true;
    user.emailConfirmationToken = undefined;
    user.emailConfirmationExpires = undefined;

    const newDoc = await user.save({ validateBeforeSave: false });

    createSendToken(newDoc, 200, req, res);
  });

exports.login = (Model) =>
  catchAsync(async (req, res, next) => {
    const { email, password } = req.body;
    // 1) Check if email and password exists
    if (!email || !password) {
      return next(new AppError("Please provide email and password", 400));
    }

    // 2) Check if user exists && password is correct
    const doc = await Model.findOne({ email: email }).select("+password");

    if (!doc || !(await doc.correctPassword(password, doc.password))) {
      return next(new AppError("Incorrect email or password", 401));
    }

    // 3) If eveything is ok, send token to client
    createSendToken(doc, 200, req, res);
  });

exports.protect = catchAsync(async (req, res, next) => {
  // 1) Getting token and check of it's there
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError("You are not logged in! Please log in to get access.", 401)
    );
  }
  // 2) Verification token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  const currentUser =
    (await User.findById(decoded.id)) || (await Seller.findById(decoded.id));
  if (!currentUser) {
    return next(
      new AppError(
        "The user belonging to this token does no longer exist.",
        401
      )
    );
  }

  // 4) Check if user changed password after the token was issued
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError("User recently changed password! Please log in again.", 401)
    );
  }

  //   GRANT ACCESS TO PROTCTED ROUTE
  req.user = currentUser;
  res.locals.user = currentUser;
  next();
});

// Only for rendered pages, no errors!
exports.isLoggedIn = (Model) => async (req, res, next) => {
  if (req.cookies.jwt) {
    try {
      // 1) verify  token
      const decoded = await promisify(jwt.verify)(
        req.cookies.jwt,
        process.env.JWT_SECRET
      );

      // 2) Check if user still exists
      const currentUser = await Model.findById(decoded.id);
      if (!currentUser) {
        return next();
      }

      // 4) Check if user changed password after the token was issued
      if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next();
      }

      //  THERE IS AN LOGGED IN USER
      req.user = currentUser;
      res.locals.user = currentUser;
      return next();
    } catch (err) {
      return next();
    }
  }
  next();
};

exports.allowedTo = (role) => {
  return (req, res, next) => {
    console.log(req.user);
    if (!(role === req.user.role)) {
      return next(
        new AppError("You do not have permission to perform this action", 403)
      );
    }

    next();
  };
};
