#!/bin/bash


cd com.marikar.rocrailcontrol.sdPlugin
npm install
cd -

rm -f com.marikar.rocrailcontrol.streamDeckPlugin && zip -r com.marikar.rocrailcontrol.streamDeckPlugin com.marikar.rocrailcontrol.sdPlugin

